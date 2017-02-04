﻿// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

'use strict';

var util = require('util'),
  path = require('path'),
  Sway = require('sway'),
  msRest = require('ms-rest'),
  HttpRequest = msRest.WebResource,
  SpecResolver = require('./specResolver'),
  SpecValidationResult = require('./specValidationResult'),
  utils = require('./util/utils'),
  Constants = require('./util/constants'),
  log = require('./util/logging'),
  ResponseWrapper = require('./responseWrapper'),
  ErrorCodes = Constants.ErrorCodes;

/*
 * @class
 * Performs sematic and data validation of the given swagger spec.
 */
class SpecValidator {

  /*
   * @constructor
   * Initializes a new instance of the SpecValidator class.
   * 
   * @param {string} specPath the (remote|local) swagger spec path
   * 
   * @param {object} [specInJson] the parsed spec in json format
   * 
   * @return {object} An instance of the SpecValidator class.
   */
  constructor(specPath, specInJson) {
    if (specPath === null || specPath === undefined || typeof specPath.valueOf() !== 'string' || !specPath.trim().length) {
      throw new Error('specPath is a required parameter of type string and it cannot be an empty string.')
    }
    //If the spec path is a url starting with https://github then let us auto convert it to an https://raw.githubusercontent url.
    if (specPath.startsWith('https://github')) {
      specPath = specPath.replace(/^https:\/\/(github.com)(.*)blob\/(.*)/ig, 'https://raw.githubusercontent.com$2$3');
    }
    this.specPath = specPath;
    this.specDir = path.dirname(this.specPath);
    this.specInJson = specInJson;
    this.specResolver = null;
    this.validationResult = new SpecValidationResult();
    this.swaggerApi = null;
  }

  /*
   * Initializes the spec validator. Resolves the spec on different counts using the SpecResolver and initializes the internal api validator.
   */
  initialize() {
    let self = this;
    return utils.parseJson(self.specPath).then(function (result) {
      self.specInJson = result;
      self.specResolver = new SpecResolver(self.specPath, self.specInJson);
      return self.specResolver.resolve();
    }).then(function () {
      let options = {};
      options.definition = self.specInJson;
      options.jsonRefs = {};
      options.jsonRefs.relativeBase = self.specDir;
      return Sway.create(options);
    }).then(function (api) {
      self.swaggerApi = api;
      return Promise.resolve(api);
    }).catch(function (err) {
      let e = self.constructErrorObject(ErrorCodes.ResolveSpecError, err.message, [err]);
      self.validationResult.resolveSpec(e);
      log.error(`${ErrorCodes.ResolveSpecError}: ${err.message}.`);
      log.silly(err.stack);
      return Promise.reject(e);
    });
  }

  validateSpec() {
    let self = this;
    self.validationResult.initializeValidateSpec();
    if (!self.swaggerApi) {
      throw this.validationResult.constructInitializationError('validateSpec');
    }
    try {
      let validationResult = self.swaggerApi.validate();
      if (validationResult) {
        if (validationResult.errors && validationResult.errors.length) {
          self.specValidationResult.validateSpec.isValid = false;
          let e = self.constructErrorObject(ErrorCodes.SemanticValidationError, `The spec ${self.specPath} has semantic validation errors.`, validationResult.errors);
          self.specValidationResult.validateSpec.error = e;
          log.error(Constants.Errors);
          log.error('------');
          self.specValidationResult.updateValidityStatus();
          log.error(e);
        } else {
          self.specValidationResult.validateSpec.result = `The spec ${self.specPath} is sematically valid.`
        }
        if (validationResult.warnings && validationResult.warnings.length > 0) {
          self.specValidationResult.validateSpec.warning = validationResult.warnings;
          log.warn(Constants.Warnings);
          log.warn('--------');
          log.warn(util.inspect(validationResult.warnings));
        }
      }
    } catch (err) {
      let msg = `An Internal Error occurred in validating the spec "${self.specPath}". \t${err.message}.`;
      err.code = ErrorCodes.InternalError;
      err.message = msg;
      self.specValidationResult.validateSpec.isValid = false;
      self.specValidationResult.validateSpec.error = err;
      log.error(err);
      self.specValidationResult.updateValidityStatus();
    }
  }

  /*
   * Gets the operation object by operationId specified in the swagger spec.
   * 
   * @param {string} id - The operation id.
   * 
   * @return {object} operation - The operation object.
   */
  getOperationById(id) {
    let self = this;
    if (!self.swaggerApi) {
      throw this.validationResult.constructInitializationError('getOperationById');
    }
    if (!id) {
      throw new Error(`id cannot be null or undefined and must be of type string.`);
    }
    let result = this.swaggerApi.getOperations().find(function (item) {
      return (item.operationId === id);
    });
    return result;
  }

  /*
   * Gets the x-ms-examples object for an operation if specified in the swagger spec.
   * 
   * @param {string|object} idOrObj - The operation id or the operation object.
   * 
   * @return {object} xmsExample - The xmsExample object.
   */
  getXmsExamples(idOrObj) {
    if (!idOrObj) {
      throw new Error(`idOrObj cannot be null or undefined and must be of type string or object.`);
    }
    let operation = {};
    if (typeof idOrObj.valueOf() === 'string') {
      operation = self.getOperationById(id);
    } else {
      operation = idOrObj;
    }
    let result;
    if (operation && operation[Constants.xmsExamples]) {
      result = operation[Constants.xmsExamples];
    }
    return result;
  }

  /*
   * Validates the given operation.
   * 
   * @param {object} operation - The operation object.
   */
  validateOperation(operation) {
    let self = this;
    self.validateXmsExamples(operation);
    self.validateExample(operation);
  }

  /*
   * Validates the given operationIds or all the operations in the spec.
   * 
   * @param {string} [operationIds] - A comma sparated string specifying the operations to be validated. 
   * If not specified then the entire spec is validated.
   */
  validateOperations(operationIds) {
    let self = this;
    if (!self.swaggerApi) {
      throw this.validationResult.constructInitializationError('validateOperations');
    }
    if (operationIds !== null && operationIds !== undefined && typeof operationIds.valueOf() !== 'string') {
      throw new Error(`operationIds parameter must be of type 'string'.`);
    }

    let operations = self.swaggerApi.getOperations();
    if (operationIds) {
      let operationIdsObj = {};
      operationIds.trim().split(',').map(function (item) { operationIdsObj[item.trim()] = 1; });
      let operationsToValidate = operations.filter(function (item) {
        return Boolean(operationIdsObj[item.operationId]);
      });
      if (operationsToValidate.length) operations = operationsToValidate;
    }

    for (let i = 0; i < operations.length; i++) {
      let operation = operations[i];
      self.specValidationResult.operations[operation.operationId] = {};
      self.specValidationResult.operations[operation.operationId][Constants.xmsExamples] = {};
      self.specValidationResult.operations[operation.operationId][Constants.exampleInSpec] = {};
      self.validateOperation(operation);
      if (Object.keys(self.specValidationResult.operations[operation.operationId][Constants.exampleInSpec]).length === 0) {
        delete self.specValidationResult.operations[operation.operationId][Constants.exampleInSpec];
      }
    }
  }

  /*
   * Validates the x-ms-examples object for an operation if specified in the swagger spec.
   * 
   * @param {object} operation - The operation object.
   */
  validateXmsExamples(operation) {
    let self = this;
    if (operation === null || operation === undefined || typeof operation !== 'object') {
      throw new Error('operation cannot be null or undefined and must be of type \'object\'.');
    }
    let xmsExamples = operation[Constants.xmsExamples];
    let result = { scenarios: {} };
    let resultScenarios = result.scenarios;
    if (xmsExamples) {
      for (let scenario in xmsExamples) {
        let xmsExample = xmsExamples[scenario];
        resultScenarios[scenario] = {};
        resultScenarios[scenario].requestValidation = self.validateRequest(operation, xmsExample.parameters);
        resultScenarios[scenario].responseValidation = self.validateXmsExampleResponses(operation, xmsExample.responses);
      }
    } else {
      let msg = `x-ms-example not found in ${operation.operationId}.`;
      result.exampleNotFound = self.constructErrorObject(ErrorCodes.XmsExampleNotFoundError, msg, null, true);
    }
    self.constructOperationResult(operation, result, Constants.xmsExamples);
    return;
  }

  /*
   * Validates the example provided in the spec for the given operation if specified in the spec.
   * 
   * @param {object} operation - The operation object.
   */
  validateExample(operation) {
    let self = this;
    if (operation === null || operation === undefined || typeof operation !== 'object') {
      throw new Error('operation cannot be null or undefined and must be of type \'object\'.');
    }
    let result = {};
    result.requestValidation = self.validateExampleRequest(operation);
    result.responseValidation = self.validateExampleResponses(operation);
    self.constructOperationResult(operation, result, Constants.exampleInSpec);
    return;
  }

  /*
   * Validates the request for an operation.
   * 
   * @param {object} operation - The operation object.
   * 
   * @param {object} exampleParameterValues - The example parameter values.
   * 
   * @return {object} result - The validation result.
   */
  validateRequest(operation, exampleParameterValues) {
    let self = this;
    if (operation === null || operation === undefined || typeof operation !== 'object') {
      throw new Error('operation cannot be null or undefined and must be of type \'object\'.');
    }

    if (exampleParameterValues === null || exampleParameterValues === undefined || typeof exampleParameterValues !== 'object') {
      throw new Error(`In operation "${operation.operationId}", exampleParameterValues cannot be null or undefined and must be of type "object" (A dictionary of key-value pairs of parameter-names and their values).`);
    }

    let parameters = operation.getParameters();
    let result = { request: null, validationResult: { errors: [], warnings: [] } }, foundIssues = false;
    let options = {};

    options.method = operation.method;
    options.pathTemplate = operation.pathObject.path;
    for (let i = 0; i < parameters.length; i++) {
      let parameter = parameters[i];
      if (!exampleParameterValues[parameter.name]) {
        if (parameter.required) {
          let msg = `In operation "${operation.operationId}", parameter ${parameter.name} is required in the swagger spec but is not present in the provided example parameter values.`;
          let e = self.constructErrorObject(ErrorCodes.RequiredParameterExampleNotFound, msg);
          result.validationResult.errors.push(e);
          foundIssues = true;
          break;
        }
        continue;
      }
      let location = parameter.in;
      if (location === 'path' || location === 'query') {
        let paramType = location + 'Parameters';
        if (!options[paramType]) options[paramType] = {};
        if (parameter[Constants.xmsSkipUrlEncoding]) {
          options[paramType][parameter.name] = {
            value: exampleParameterValues[parameter.name],
            skipUrlEncoding: true
          };
        } else {
          options[paramType][parameter.name] = exampleParameterValues[parameter.name];
        }
      } else if (location === 'body') {
        options.body = exampleParameterValues[parameter.name];
        options.disableJsonStringifyOnBody = true;
      } else if (location === 'header') {
        if (!options.headers) options.headers = {};
        options.headers[parameter.name] = exampleParameterValues[parameter.name];
      }
    }

    let request = null;
    let validationResult = {};
    if (!foundIssues) {
      try {
        request = new HttpRequest()
        request = request.prepare(options);
        validationResult = operation.validateRequest(request);
      } catch (err) {
        request = null;
        let e = self.constructErrorObject(ErrorCodes.ErrorInPreparingRequest, error.message, [err]);
        validationResult.errors.push(e);
      }
    }

    result.request = request;
    result.validationResult = utils.mergeObjects(validationResult, result.validationResult);
    return result;
  }

  /*
   * Validates the response for an operation.
   * 
   * @param {object} operationOrResponse - The operation or the response object.
   * 
   * @param {object} responseWrapper - The example responseWrapper.
   * 
   * @return {object} result - The validation result.
   */
  validateResponse(operationOrResponse, responseWrapper) {
    let self = this;
    if (operationOrResponse === null || operationOrResponse === undefined || typeof operationOrResponse !== 'object') {
      throw new Error('operationOrResponse cannot be null or undefined and must be of type \'object\'.');
    }

    if (responseWrapper === null || responseWrapper === undefined || typeof responseWrapper !== 'object') {
      throw new Error('responseWrapper cannot be null or undefined and must be of type \'object\'.');
    }

    return operationOrResponse.validateResponse(responseWrapper);
  }

  /*
   * Validates the example (request) for an operation if specified in the swagger spec.
   * 
   * @param {object} operation - The operation object.
   * 
   * @return {object} result - The validation result.
   */
  validateExampleRequest(operation) {
    let self = this;
    if (operation === null || operation === undefined || typeof operation !== 'object') {
      throw new Error('operation cannot be null or undefined and must be of type \'object\'.');
    }
    let parameters = operation.getParameters();
    //as per swagger specification https://github.com/OAI/OpenAPI-Specification/blob/master/versions/2.0.md#fixed-fields-13
    //example can only be provided in a schema and schema can only be provided for a body parameter. Hence, if the body 
    //parameter schema has an example, then we will populate sample values for other parameters and create a request object.
    //This request object will be used to validate the body parameter example. Otherwise, we will skip it.
    let bodyParam = parameters.find(function (item) {
      return (item.in === 'body');
    });
    let result = {};
    if (bodyParam && bodyParam.schema && bodyParam.schema.example) {
      let exampleParameterValues = {};
      for (let i = 0; i < parameters.length; i++) {
        log.debug(`Getting sample value for parameter "${parameters[i].name}" in operation "${operation.operationId}".`);
        //need to figure out how to register custom format validators. Till then deleting the format uuid.
        if (parameters[i].format && parameters[i].format === 'uuid') {
          delete parameters[i].format;
          delete parameters[i].schema.format;
        }
        exampleParameterValues[parameters[i].name] = parameters[i].getSample();
      }
      exampleParameterValues[bodyParam.name] = bodyParam.schema.example;
      result = self.validateRequest(operation, exampleParameterValues);
    }
    return result;
  }

  /*
   * Validates the responses given in x-ms-examples object for an operation.
   * 
   * @param {object} operation - The operation object.
   * 
   * @param {object} exampleResponseValue - The example response value.
   * 
   * @return {object} result - The validation result.
   */
  validateXmsExampleResponses(operation, exampleResponseValue) {
    let self = this;
    let result = {};
    if (operation === null || operation === undefined || typeof operation !== 'object') {
      throw new Error('operation cannot be null or undefined and must be of type \'object\'.');
    }

    if (exampleResponseValue === null || exampleResponseValue === undefined || typeof exampleResponseValue !== 'object') {
      throw new Error('operation cannot be null or undefined and must be of type \'object\'.');
    }
    let responsesInSwagger = {};
    let responses = operation.getResponses().map(function (response) {
      responsesInSwagger[response.statusCode] = response.statusCode;
      return response.statusCode;
    });
    for (let exampleResponseStatusCode in exampleResponseValue) {
      let response = operation.getResponse(exampleResponseStatusCode);
      if (responsesInSwagger[exampleResponseStatusCode]) delete responsesInSwagger[exampleResponseStatusCode];
      result[exampleResponseStatusCode] = { errors: [], warnings: [] };
      //have to ensure how to map negative status codes to default. There have been several issues filed in the Autorest repo, w.r.t how
      //default is handled. While solving that issue, we may come up with some extension. Once that is finalized, we should code accordingly over here.
      if (!response) {
        let msg = `Response statusCode "${exampleResponseStatusCode}" for operation "${operation.operationId}" is provided in exampleResponseValue, ` +
          `however it is not present in the swagger spec.`;
        let e = self.constructErrorObject(ErrorCodes.ResponseStatusCodeNotInSpec, msg);
        result[exampleResponseStatusCode].errors.push(e);
        log.error(e);
        continue;
      }

      let exampleResponseHeaders = exampleResponseValue[exampleResponseStatusCode]['headers'] || {};
      let exampleResponseBody = exampleResponseValue[exampleResponseStatusCode]['body'];
      if (exampleResponseBody && !response.schema) {
        let msg = `Response statusCode "${exampleResponseStatusCode}" for operation "${operation.operationId}" has response body provided in the example, ` +
          `however the response does not have a "schema" defined in the swagger spec.`;
        let e = self.constructErrorObject(ErrorCodes.ResponseSchemaNotInSpec, msg);
        result[exampleResponseStatusCode].errors.push(e);
        log.error(e);
        continue;
      }
      //ensure content-type header is present
      if (!(exampleResponseHeaders['content-type'] || exampleResponseHeaders['Content-Type'])) {
        exampleResponseHeaders['content-type'] = operation.produces[0];
      }
      let exampleResponse = new ResponseWrapper(exampleResponseStatusCode, exampleResponseBody, exampleResponseHeaders);
      let validationResult = self.validateResponse(operation, exampleResponse);
      result[exampleResponseStatusCode] = validationResult;
    }
    let responseWithoutXmsExamples = Object.keys(responsesInSwagger).filter(function (statusCode) {
      if (statusCode !== 'default') {
        //let intStatusCode = parseInt(statusCode);
        //if (!isNaN(intStatusCode) && intStatusCode < 400) {
        return statusCode;
        //}
      }
    });
    if (responseWithoutXmsExamples && responseWithoutXmsExamples.length) {
      let msg = `Following response status codes "${responseWithoutXmsExamples}" for operation "${operation.operationId}" were present in the swagger spec, ` +
        `however they were not present in x-ms-examples. Please provide them.`;
    }
    return result;
  }

  /*
   * Validates the example responses for a given operation.
   * 
   * @param {object} operation - The operation object.
   * 
   * @return {object} result - The validation result.
   */
  validateExampleResponses(operation) {
    let self = this;
    if (operation === null || operation === undefined || typeof operation !== 'object') {
      throw new Error('operation cannot be null or undefined and must be of type \'object\'.');
    }
    let result = {};
    let responses = operation.getResponses();
    for (let i = 0; i < responses.length; i++) {
      let response = responses[i];
      if (response.examples) {
        for (let mimeType in response.examples) {
          let exampleResponseBody = response.examples[mimeType];
          let exampleResponseHeaders = { 'content-type': mimeType };
          let exampleResponse = new ResponseWrapper(response.statusCode, exampleResponseBody, exampleResponseHeaders);
          let validationResult = self.validateResponse(operation, exampleResponse);
          result[response.statusCode] = validationResult;
        }
      }
    }
    return result;
  }

}

module.exports = SpecValidator;