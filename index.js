'use strict'

/* eslint no-prototype-builtins: 0 */

const merge = require('@fastify/deepmerge')()
const clone = require('rfdc')({ proto: true })
const { randomUUID } = require('crypto')

const validate = require('./schema-validator')
const Serializer = require('./serializer')
const Validator = require('./validator')
const RefResolver = require('./ref-resolver')

let largeArraySize = 2e4
let largeArrayMechanism = 'default'
const validLargeArrayMechanisms = [
  'default',
  'json-stringify'
]

const addComma = `
  if (addComma) {
    json += ','
  } else {
    addComma = true
  }
`

function isValidSchema (schema, name) {
  if (!validate(schema)) {
    if (name) {
      name = `"${name}" `
    } else {
      name = ''
    }
    const first = validate.errors[0]
    const err = new Error(`${name}schema is invalid: data${first.instancePath} ${first.message}`)
    err.errors = isValidSchema.errors
    throw err
  }
}

function mergeLocation (location, key) {
  return {
    schema: location.schema[key],
    schemaId: location.schemaId,
    jsonPointer: location.jsonPointer + '/' + key
  }
}

function resolveRef (location, ref) {
  let hashIndex = ref.indexOf('#')
  if (hashIndex === -1) {
    hashIndex = ref.length
  }

  const schemaId = ref.slice(0, hashIndex) || location.schemaId
  const jsonPointer = ref.slice(hashIndex) || '#'

  const schema = refResolver.getSchema(schemaId, jsonPointer)

  if (schema === undefined) {
    throw new Error(`Cannot find reference "${ref}"`)
  }

  if (schema.$ref !== undefined) {
    return resolveRef({ schema, schemaId, jsonPointer }, schema.$ref)
  }

  return { schema, schemaId, jsonPointer }
}

const arrayItemsReferenceSerializersMap = new Map()
const objectReferenceSerializersMap = new Map()

let rootSchemaId = null
let refResolver = null
let validator = null
let contextFunctions = null

function build (schema, options) {
  arrayItemsReferenceSerializersMap.clear()
  objectReferenceSerializersMap.clear()

  contextFunctions = []
  options = options || {}

  refResolver = new RefResolver()
  validator = new Validator(options.ajv)

  rootSchemaId = schema.$id || randomUUID()

  isValidSchema(schema)
  validator.addSchema(schema, rootSchemaId)
  refResolver.addSchema(schema, rootSchemaId)

  if (options.schema) {
    for (const key of Object.keys(options.schema)) {
      isValidSchema(options.schema[key], key)
      validator.addSchema(options.schema[key], key)
      refResolver.addSchema(options.schema[key], key)
    }
  }

  if (options.rounding) {
    if (!['floor', 'ceil', 'round'].includes(options.rounding)) {
      throw new Error(`Unsupported integer rounding method ${options.rounding}`)
    }
  }

  if (options.largeArrayMechanism) {
    if (validLargeArrayMechanisms.includes(options.largeArrayMechanism)) {
      largeArrayMechanism = options.largeArrayMechanism
    } else {
      throw new Error(`Unsupported large array mechanism ${options.rounding}`)
    }
  }

  if (options.largeArraySize) {
    if (!Number.isNaN(Number.parseInt(options.largeArraySize, 10))) {
      largeArraySize = options.largeArraySize
    } else {
      throw new Error(`Unsupported large array size. Expected integer-like, got ${options.largeArraySize}`)
    }
  }

  const serializer = new Serializer(options)

  const location = { schema, schemaId: rootSchemaId, jsonPointer: '#' }
  const code = buildValue(location, 'input')

  const contextFunctionCode = `
    function main (input) {
      let json = ''
      ${code}
      return json
    }
    ${contextFunctions.join('\n')}
    return main
    `

  const dependenciesName = ['validator', 'serializer', contextFunctionCode]

  if (options.debugMode) {
    options.mode = 'debug'
  }

  if (options.mode === 'debug') {
    return { code: dependenciesName.join('\n'), validator, ajv: validator.ajv }
  }

  if (options.mode === 'standalone') {
    // lazy load
    const buildStandaloneCode = require('./standalone')
    return buildStandaloneCode(options, validator, contextFunctionCode)
  }

  /* eslint no-new-func: "off" */
  const contextFunc = new Function('validator', 'serializer', contextFunctionCode)
  const stringifyFunc = contextFunc(validator, serializer)

  refResolver = null
  validator = null
  rootSchemaId = null
  contextFunctions = null
  arrayItemsReferenceSerializersMap.clear()
  objectReferenceSerializersMap.clear()

  return stringifyFunc
}

const objectKeywords = [
  'maxProperties',
  'minProperties',
  'required',
  'properties',
  'patternProperties',
  'additionalProperties',
  'dependencies'
]

const arrayKeywords = [
  'items',
  'additionalItems',
  'maxItems',
  'minItems',
  'uniqueItems',
  'contains'
]

const stringKeywords = [
  'maxLength',
  'minLength',
  'pattern'
]

const numberKeywords = [
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum'
]

/**
 * Infer type based on keyword in order to generate optimized code
 * https://datatracker.ietf.org/doc/html/draft-handrews-json-schema-validation-01#section-6
 */
function inferTypeByKeyword (schema) {
  // eslint-disable-next-line
  for (var keyword of objectKeywords) {
    if (keyword in schema) return 'object'
  }
  // eslint-disable-next-line
  for (var keyword of arrayKeywords) {
    if (keyword in schema) return 'array'
  }
  // eslint-disable-next-line
  for (var keyword of stringKeywords) {
    if (keyword in schema) return 'string'
  }
  // eslint-disable-next-line
  for (var keyword of numberKeywords) {
    if (keyword in schema) return 'number'
  }
  return schema.type
}

function addPatternProperties (location) {
  const schema = location.schema
  const pp = schema.patternProperties
  let code = `
      var properties = ${JSON.stringify(schema.properties)} || {}
      var keys = Object.keys(obj)
      for (var i = 0; i < keys.length; i++) {
        if (properties[keys[i]]) continue
  `

  const patternPropertiesLocation = mergeLocation(location, 'patternProperties')
  Object.keys(pp).forEach((regex) => {
    let ppLocation = mergeLocation(patternPropertiesLocation, regex)
    if (pp[regex].$ref) {
      ppLocation = resolveRef(ppLocation, pp[regex].$ref)
      pp[regex] = ppLocation.schema
    }

    try {
      RegExp(regex)
    } catch (err) {
      throw new Error(`${err.message}. Found at ${regex} matching ${JSON.stringify(pp[regex])}`)
    }

    const valueCode = buildValue(ppLocation, 'obj[keys[i]]')
    code += `
      if (/${regex.replace(/\\*\//g, '\\/')}/.test(keys[i])) {
        ${addComma}
        json += serializer.asString(keys[i]) + ':'
        ${valueCode}
        continue
      }
    `
  })
  if (schema.additionalProperties) {
    code += additionalProperty(location)
  }

  code += `
      }
  `
  return code
}

function additionalProperty (location) {
  const ap = location.schema.additionalProperties
  let code = ''
  if (ap === true) {
    code += `
        if (obj[keys[i]] !== undefined && typeof obj[keys[i]] !== 'function' && typeof obj[keys[i]] !== 'symbol') {
          ${addComma}
          json += serializer.asString(keys[i]) + ':' + JSON.stringify(obj[keys[i]])
        }
    `

    return code
  }

  let apLocation = mergeLocation(location, 'additionalProperties')
  if (apLocation.schema.$ref) {
    apLocation = resolveRef(apLocation, apLocation.schema.$ref)
  }

  const valueCode = buildValue(apLocation, 'obj[keys[i]]')

  code += `
    ${addComma}
    json += serializer.asString(keys[i]) + ':'
    ${valueCode}
  `

  return code
}

function addAdditionalProperties (location) {
  return `
      var properties = ${JSON.stringify(location.schema.properties)} || {}
      var keys = Object.keys(obj)
      for (var i = 0; i < keys.length; i++) {
        if (properties[keys[i]]) continue
        ${additionalProperty(location)}
      }
  `
}

function buildCode (location) {
  if (location.schema.$ref) {
    location = resolveRef(location, location.schema.$ref)
  }

  const schema = location.schema
  const required = schema.required || []

  let code = ''

  const propertiesLocation = mergeLocation(location, 'properties')
  Object.keys(schema.properties || {}).forEach((key) => {
    let propertyLocation = mergeLocation(propertiesLocation, key)
    if (propertyLocation.$ref) {
      propertyLocation = resolveRef(location, propertyLocation.$ref)
    }

    const sanitized = JSON.stringify(key)
    const asString = JSON.stringify(sanitized)

    // Using obj['key'] !== undefined instead of obj.hasOwnProperty(prop) for perf reasons,
    // see https://github.com/mcollina/fast-json-stringify/pull/3 for discussion.

    code += `
      if (obj[${sanitized}] !== undefined) {
        ${addComma}
        json += ${asString} + ':'
      `

    code += buildValue(propertyLocation, `obj[${JSON.stringify(key)}]`)

    const defaultValue = propertyLocation.schema.default
    if (defaultValue !== undefined) {
      code += `
      } else {
        ${addComma}
        json += ${asString} + ':' + ${JSON.stringify(JSON.stringify(defaultValue))}
      `
    } else if (required.includes(key)) {
      code += `
      } else {
        throw new Error('${sanitized} is required!')
      `
    }

    code += `
      }
    `
  })

  for (const requiredProperty of required) {
    if (schema.properties && schema.properties[requiredProperty] !== undefined) continue
    code += `if (obj['${requiredProperty}'] === undefined) throw new Error('"${requiredProperty}" is required!')\n`
  }

  return code
}

function mergeAllOfSchema (location, schema, mergedSchema) {
  const allOfLocation = mergeLocation(location, 'allOf')

  for (let i = 0; i < schema.allOf.length; i++) {
    let allOfSchema = schema.allOf[i]

    if (allOfSchema.$ref) {
      const allOfSchemaLocation = mergeLocation(allOfLocation, i)
      allOfSchema = resolveRef(allOfSchemaLocation, allOfSchema.$ref).schema
    }

    let allOfSchemaType = allOfSchema.type
    if (allOfSchemaType === undefined) {
      allOfSchemaType = inferTypeByKeyword(allOfSchema)
    }

    if (allOfSchemaType !== undefined) {
      if (
        mergedSchema.type !== undefined &&
        mergedSchema.type !== allOfSchemaType
      ) {
        throw new Error('allOf schemas have different type values')
      }
      mergedSchema.type = allOfSchemaType
    }

    if (allOfSchema.format !== undefined) {
      if (
        mergedSchema.format !== undefined &&
        mergedSchema.format !== allOfSchema.format
      ) {
        throw new Error('allOf schemas have different format values')
      }
      mergedSchema.format = allOfSchema.format
    }

    if (allOfSchema.nullable !== undefined) {
      if (
        mergedSchema.nullable !== undefined &&
        mergedSchema.nullable !== allOfSchema.nullable
      ) {
        throw new Error('allOf schemas have different nullable values')
      }
      mergedSchema.nullable = allOfSchema.nullable
    }

    if (allOfSchema.properties !== undefined) {
      if (mergedSchema.properties === undefined) {
        mergedSchema.properties = {}
      }
      Object.assign(mergedSchema.properties, allOfSchema.properties)
    }

    if (allOfSchema.additionalProperties !== undefined) {
      if (mergedSchema.additionalProperties === undefined) {
        mergedSchema.additionalProperties = {}
      }
      Object.assign(mergedSchema.additionalProperties, allOfSchema.additionalProperties)
    }

    if (allOfSchema.patternProperties !== undefined) {
      if (mergedSchema.patternProperties === undefined) {
        mergedSchema.patternProperties = {}
      }
      Object.assign(mergedSchema.patternProperties, allOfSchema.patternProperties)
    }

    if (allOfSchema.required !== undefined) {
      if (mergedSchema.required === undefined) {
        mergedSchema.required = []
      }
      mergedSchema.required.push(...allOfSchema.required)
    }

    if (allOfSchema.oneOf !== undefined) {
      if (mergedSchema.oneOf === undefined) {
        mergedSchema.oneOf = []
      }
      mergedSchema.oneOf.push(...allOfSchema.oneOf)
    }

    if (allOfSchema.anyOf !== undefined) {
      if (mergedSchema.anyOf === undefined) {
        mergedSchema.anyOf = []
      }
      mergedSchema.anyOf.push(...allOfSchema.anyOf)
    }

    if (allOfSchema.allOf !== undefined) {
      mergeAllOfSchema(location, allOfSchema, mergedSchema)
    }
  }
  delete mergedSchema.allOf

  mergedSchema.$id = `merged_${randomUUID()}`
  validator.addSchema(mergedSchema)
  refResolver.addSchema(mergedSchema)
  location.schemaId = mergedSchema.$id
  location.jsonPointer = '#'
}

function buildInnerObject (location) {
  const schema = location.schema
  let code = buildCode(location)
  if (schema.patternProperties) {
    code += addPatternProperties(location)
  } else if (schema.additionalProperties && !schema.patternProperties) {
    code += addAdditionalProperties(location)
  }
  return code
}

function addIfThenElse (location) {
  const schema = merge({}, location.schema)
  const thenSchema = schema.then
  const elseSchema = schema.else || { additionalProperties: true }

  delete schema.if
  delete schema.then
  delete schema.else

  const ifLocation = mergeLocation(location, 'if')
  const ifSchemaRef = ifLocation.schemaId + ifLocation.jsonPointer

  let code = `
    if (validator.validate("${ifSchemaRef}", obj)) {
  `

  const thenLocation = mergeLocation(location, 'then')
  thenLocation.schema = merge(schema, thenSchema)

  if (thenSchema.if && thenSchema.then) {
    code += addIfThenElse(thenLocation)
  } else {
    code += buildInnerObject(thenLocation)
  }
  code += `
    }
  `

  const elseLocation = mergeLocation(location, 'else')
  elseLocation.schema = merge(schema, elseSchema)

  code += `
      else {
    `

  if (elseSchema.if && elseSchema.then) {
    code += addIfThenElse(elseLocation)
  } else {
    code += buildInnerObject(elseLocation)
  }
  code += `
      }
    `
  return code
}

function toJSON (variableName) {
  return `(${variableName} && typeof ${variableName}.toJSON === 'function')
    ? ${variableName}.toJSON()
    : ${variableName}
  `
}

function buildObject (location) {
  const schema = location.schema

  if (objectReferenceSerializersMap.has(schema)) {
    return objectReferenceSerializersMap.get(schema)
  }

  const functionName = generateFuncName()
  objectReferenceSerializersMap.set(schema, functionName)

  const schemaId = location.schemaId === rootSchemaId ? '' : location.schemaId
  let functionCode = `
    function ${functionName} (input) {
      // ${schemaId + location.jsonPointer}
  `
  if (schema.nullable) {
    functionCode += `
      if (input === null) {
        return 'null';
      }
  `
  }

  functionCode += `
      var obj = ${toJSON('input')}
      var json = '{'
      var addComma = false
  `

  if (schema.if && schema.then) {
    functionCode += addIfThenElse(location)
  } else {
    functionCode += buildInnerObject(location)
  }

  functionCode += `
      json += '}'
      return json
    }
  `

  contextFunctions.push(functionCode)
  return functionName
}

function buildArray (location) {
  const schema = location.schema

  let itemsLocation = mergeLocation(location, 'items')
  itemsLocation.schema = itemsLocation.schema || {}

  if (itemsLocation.schema.$ref) {
    itemsLocation = resolveRef(itemsLocation, itemsLocation.schema.$ref)
  }

  const itemsSchema = itemsLocation.schema

  if (arrayItemsReferenceSerializersMap.has(itemsSchema)) {
    return arrayItemsReferenceSerializersMap.get(itemsSchema)
  }

  const functionName = generateFuncName()
  arrayItemsReferenceSerializersMap.set(itemsSchema, functionName)

  const schemaId = location.schemaId === rootSchemaId ? '' : location.schemaId
  let functionCode = `
    function ${functionName} (obj) {
      // ${schemaId + location.jsonPointer}
  `

  if (schema.nullable) {
    functionCode += `
      if (obj === null) {
        return 'null';
      }
    `
  }

  functionCode += `
    if (!Array.isArray(obj)) {
      throw new TypeError(\`The value '$\{obj}' does not match schema definition.\`)
    }
    const arrayLength = obj.length
  `

  if (!schema.additionalItems) {
    functionCode += `
      if (arrayLength > ${itemsSchema.length}) {
        throw new Error(\`Item at ${itemsSchema.length} does not match schema definition.\`)
      }
    `
  }

  if (largeArrayMechanism !== 'default') {
    if (largeArrayMechanism === 'json-stringify') {
      functionCode += `if (arrayLength && arrayLength >= ${largeArraySize}) return JSON.stringify(obj)\n`
    } else {
      throw new Error(`Unsupported large array mechanism ${largeArrayMechanism}`)
    }
  }

  functionCode += `
    let jsonOutput = ''
  `

  if (Array.isArray(itemsSchema)) {
    for (let i = 0; i < itemsSchema.length; i++) {
      const item = itemsSchema[i]
      const tmpRes = buildValue(mergeLocation(itemsLocation, i), `obj[${i}]`)
      functionCode += `
        if (${i} < arrayLength) {
          if (${buildArrayTypeCondition(item.type, `[${i}]`)}) {
            let json = ''
            ${tmpRes}
            jsonOutput += json
            if (${i} < arrayLength - 1) {
              jsonOutput += ','
            }
          } else {
            throw new Error(\`Item at ${i} does not match schema definition.\`)
          }
        }
        `
    }

    if (schema.additionalItems) {
      functionCode += `
        for (let i = ${itemsSchema.length}; i < arrayLength; i++) {
          let json = JSON.stringify(obj[i])
          jsonOutput += json
          if (i < arrayLength - 1) {
            jsonOutput += ','
          }
        }`
    }
  } else {
    const code = buildValue(itemsLocation, 'obj[i]')
    functionCode += `
      for (let i = 0; i < arrayLength; i++) {
        let json = ''
        ${code}
        jsonOutput += json
        if (i < arrayLength - 1) {
          jsonOutput += ','
        }
      }`
  }

  functionCode += `
    return \`[\${jsonOutput}]\`
  }`

  contextFunctions.push(functionCode)
  return functionName
}

function buildArrayTypeCondition (type, accessor) {
  let condition
  switch (type) {
    case 'null':
      condition = `obj${accessor} === null`
      break
    case 'string':
      condition = `typeof obj${accessor} === 'string'`
      break
    case 'integer':
      condition = `Number.isInteger(obj${accessor})`
      break
    case 'number':
      condition = `Number.isFinite(obj${accessor})`
      break
    case 'boolean':
      condition = `typeof obj${accessor} === 'boolean'`
      break
    case 'object':
      condition = `obj${accessor} && typeof obj${accessor} === 'object' && obj${accessor}.constructor === Object`
      break
    case 'array':
      condition = `Array.isArray(obj${accessor})`
      break
    default:
      if (Array.isArray(type)) {
        const conditions = type.map((subType) => {
          return buildArrayTypeCondition(subType, accessor)
        })
        condition = `(${conditions.join(' || ')})`
      } else {
        throw new Error(`${type} unsupported`)
      }
  }
  return condition
}

let genFuncNameCounter = 0
function generateFuncName () {
  return 'anonymous' + genFuncNameCounter++
}

function buildValue (location, input) {
  let schema = location.schema

  if (typeof schema === 'boolean') {
    return `json += JSON.stringify(${input})`
  }

  if (schema.$ref) {
    location = resolveRef(location, schema.$ref)
    schema = location.schema
  }

  if (schema.type === undefined) {
    const inferredType = inferTypeByKeyword(schema)
    if (inferredType) {
      schema.type = inferredType
    }
  }

  if (schema.allOf) {
    const mergedSchema = clone(schema)
    mergeAllOfSchema(location, schema, mergedSchema)
    schema = mergedSchema
    location.schema = mergedSchema
  }

  const type = schema.type
  const nullable = schema.nullable === true || (Array.isArray(type) && type.includes('null'))

  let code = ''
  let funcName

  if ('const' in schema) {
    if (nullable) {
      code += `
        json += ${input} === null ? 'null' : '${JSON.stringify(schema.const)}'
      `
      return code
    }
    code += `json += '${JSON.stringify(schema.const)}'`
    return code
  }

  switch (type) {
    case 'null':
      code += 'json += serializer.asNull()'
      break
    case 'string': {
      if (schema.format === 'date-time') {
        funcName = nullable ? 'serializer.asDateTimeNullable.bind(serializer)' : 'serializer.asDateTime.bind(serializer)'
      } else if (schema.format === 'date') {
        funcName = nullable ? 'serializer.asDateNullable.bind(serializer)' : 'serializer.asDate.bind(serializer)'
      } else if (schema.format === 'time') {
        funcName = nullable ? 'serializer.asTimeNullable.bind(serializer)' : 'serializer.asTime.bind(serializer)'
      } else {
        funcName = nullable ? 'serializer.asStringNullable.bind(serializer)' : 'serializer.asString.bind(serializer)'
      }
      code += `json += ${funcName}(${input})`
      break
    }
    case 'integer':
      funcName = nullable ? 'serializer.asIntegerNullable.bind(serializer)' : 'serializer.asInteger.bind(serializer)'
      code += `json += ${funcName}(${input})`
      break
    case 'number':
      funcName = nullable ? 'serializer.asNumberNullable.bind(serializer)' : 'serializer.asNumber.bind(serializer)'
      code += `json += ${funcName}(${input})`
      break
    case 'boolean':
      funcName = nullable ? 'serializer.asBooleanNullable.bind(serializer)' : 'serializer.asBoolean.bind(serializer)'
      code += `json += ${funcName}(${input})`
      break
    case 'object':
      funcName = buildObject(location)
      code += `json += ${funcName}(${input})`
      break
    case 'array':
      funcName = buildArray(location)
      code += `json += ${funcName}(${input})`
      break
    case undefined:
      if (schema.anyOf || schema.oneOf) {
        // beware: dereferenceOfRefs has side effects and changes schema.anyOf
        const type = schema.anyOf ? 'anyOf' : 'oneOf'
        const anyOfLocation = mergeLocation(location, type)

        for (let index = 0; index < location.schema[type].length; index++) {
          const optionLocation = mergeLocation(anyOfLocation, index)
          const schemaRef = optionLocation.schemaId + optionLocation.jsonPointer
          const nestedResult = buildValue(optionLocation, input)
          code += `
            ${index === 0 ? 'if' : 'else if'}(validator.validate("${schemaRef}", ${input}))
              ${nestedResult}
          `
        }

        code += `
          else throw new Error(\`The value $\{JSON.stringify(${input})} does not match schema definition.\`)
        `
      } else {
        code += `
          json += JSON.stringify(${input})
        `
      }
      break
    default:
      if (Array.isArray(type)) {
        let sortedTypes = type
        const nullable = schema.nullable === true || type.includes('null')

        if (nullable) {
          sortedTypes = sortedTypes.filter(type => type !== 'null')
          code += `
            if (${input} === null) {
              json += null
            } else {`
        }

        const locationClone = clone(location)
        sortedTypes.forEach((type, index) => {
          const statement = index === 0 ? 'if' : 'else if'
          locationClone.schema.type = type
          const nestedResult = buildValue(locationClone, input)
          switch (type) {
            case 'string': {
              code += `
                ${statement}(
                  typeof ${input} === "string" ||
                  ${input} === null ||
                  ${input} instanceof Date ||
                  ${input} instanceof RegExp ||
                  (
                    typeof ${input} === "object" &&
                    typeof ${input}.toString === "function" &&
                    ${input}.toString !== Object.prototype.toString &&
                    !(${input} instanceof Date)
                  )
                )
                  ${nestedResult}
              `
              break
            }
            case 'array': {
              code += `
                ${statement}(Array.isArray(${input}))
                  ${nestedResult}
              `
              break
            }
            case 'integer': {
              code += `
                ${statement}(Number.isInteger(${input}) || ${input} === null)
                  ${nestedResult}
              `
              break
            }
            case 'object': {
              code += `
                ${statement}(typeof ${input} === "object" || ${input} === null)
                  ${nestedResult}
              `
              break
            }
            default: {
              code += `
                ${statement}(typeof ${input} === "${type}" || ${input} === null)
                  ${nestedResult}
              `
              break
            }
          }
        })
        code += `
          else throw new Error(\`The value $\{JSON.stringify(${input})} does not match schema definition.\`)
        `

        if (nullable) {
          code += `
            }
          `
        }
      } else {
        throw new Error(`${type} unsupported`)
      }
  }

  return code
}

module.exports = build

module.exports.validLargeArrayMechanisms = validLargeArrayMechanisms

module.exports.restore = function ({ code, validator }) {
  const serializer = new Serializer()
  // eslint-disable-next-line
  return (Function.apply(null, ['validator', 'serializer', code])
    .apply(null, [validator, serializer]))
}
