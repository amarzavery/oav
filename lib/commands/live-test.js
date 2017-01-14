// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

'use strict';
var util = require('util'),
  log = require('../util/logging'),
  validate = require('../../validate');

exports.command = 'live-test <spec-path>';

exports.describe = 'Performs validation of x-ms-examples and examples present in the spec.';

exports.builder = {
  o: {
    alias: 'operationIds',
    describe: 'A comma separated string of operationIds for which the examples ' + 
    'need to be validated. If operationIds are not provided then the entire spec will be validated. ' + 
    'Example: "StorageAccounts_Create, StorageAccounts_List, Usages_List".',
    string: true
  }
};

exports.handler = function (argv) {
  log.debug('>>>>>', util.inspect(argv));
  let specPath = argv.specPath;
  let operationIds = argv.operationIds;
  if (specPath.match(/.*composite.*/ig) !== null) {
    return validate.validateExamplesInCompositeSpec(specPath);
  } else {
    return validate.liveTest(specPath, operationIds);
  }
}

exports = module.exports;