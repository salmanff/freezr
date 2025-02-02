/* 
SystemExtensions.js
serverless and other service addons

currently only with AWS - needs tobe abstracted to cover other serverless service providers

*/

const ROLE_NAME = 'freezrLambdaRole'

const {
  LambdaClient,
  LogType,
  InvokeCommand,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  GetFunctionCommand,
  DeleteFunctionCommand,
  Architecture, PackageType, Runtime
} = require('@aws-sdk/client-lambda')
const {
  IAMClient, CreateRoleCommand
} = require('@aws-sdk/client-iam')
const helpers = require('./helpers.js')
const fileHandler = require('./file_handler.js')
const fs = require('fs')

exports.version = '0.0.1'
exports.LOCAL_FUNCTIONS = ['invokeextension', 'upsertextension', 'deleteextension']
exports.ADMIN_FUNCTIONS = ['upsertextension', 'deleteextension']

const fullFunctionName = function (ownerName, appName, pureFunctionName) {
  // full name is used on the serverless system just to differentiate between potential different versions and show it is a freezr service
  if (!ownerName || !appName || !pureFunctionName) return null
  return ('freezr_' + ownerName + '_' + appName + '_' + pureFunctionName).replace(/\./g, '_')
}

exports.tasks = async function (req, res) {
  // onsole.log('tasks', { tasl: req.params.task, body: req.body, query: req.query, freezrAttributes: req.freezrAttributes })
  const credentials = req.freezrAttributes.slParams

  if (req.params.task === 'invokeserverless' || req.params.task === 'invokeextension') {
    const functionName = req.params.task === 'invokeextension'
      ? req.body.system_extension_name
      : fullFunctionName(req.freezrAttributes.owner_user_id, req.freezrAttributes.requestor_app, req.freezrAttributes.permission_name)
    if (!functionName) {
      console.warn('tasks err no func name')
      helpers.send_failure(res, new Error('invalid function name 1'), 'serverless', exports.version, 'tasks ' + req.params.task)
    } else {
      const payload = { inputParams: req.body.inputParams }

      if (req.file) { payload.file = req.file }
      if (req.body.read_collection_name) {
        payload.dbResults = {}
        try {
          const dbResults = await req.freezrAttributes.freezrDbs[req.body.read_collection_name].async.query(req.body.read_query, {})
          payload.dbResults[req.body.read_name] = dbResults
        } catch (e) {
          console.warn('error getting dbInput - allowing function to run for ' + req.freezrAttributes.permission_name, e)
        }
      }

      const resp = req.params.task === 'invokeserverless' ? await invokeFunction(credentials, functionName, payload) : await invokeLocally(req, functionName, payload)
      if (resp.error) {
        if (resp.error.name === 'ResourceNotFoundException' && !req.params.try2) {
          req.params.task = 'createinvokeserverless'
          exports.tasks(req, res)
        } else {
          helpers.send_failure(res, resp.error, 'serverless', exports.version, 'tasks ' + req.params.task)
        }
      } else if (!resp) {
        helpers.send_failure(res, new Error('no response'), 'serverless', exports.version, 'tasks ' + req.params.task)
      } else {
        if (!resp.result) resp.result = {}
        if (!resp.result.apiResponse) { resp.result.apiResponse = { error: 'internal error - no apiResponse provided' } }
        if (resp.result?.dbWrite) {
          resp.result.apiResponse.dbWrite = 'dbWrite not implemented yet'
        } else if (resp.result?.fileSave) {
          resp.result.apiResponse.fileSave = 'fileSave not implemented yet'
        }
        helpers.send_success(res, resp.result.apiResponse)
      }
    }
  } else if (['createserverless', 'createinvokeserverless', 'upsertserverless', 'updateserverless'].indexOf(req.params.task) > -1) { // for serverless functions
    const functionName = fullFunctionName(req.freezrAttributes.owner_user_id, req.freezrAttributes.requestor_app, req.freezrAttributes.permission_name)
    let code
    try {
      code = req.freezrAppFS ? await req.freezrAppFS.async.readAppFile(req.freezrAttributes.permission_name + '.zip', { doNotToString: true }) : null
    } catch (e) {
      req.freezrAppFSError = e
      console.warn('error reading code', e)
    }

    if (!functionName) {
      helpers.send_failure(res, new Error('invalid function name 2'), 'SystemExtensions', exports.version, 'tasks ' + req.params.task)
    } else if (!code) {
      if (req.freezrAppFSError) {
        helpers.send_failure(res, req.freezrAppFSError, 'SystemExtensions', exports.version, 'tasks ' + req.params.task)
      } else {
        helpers.send_failure(res, { error: 'could not read function code' })
      }
    } else if (req.params.task === 'upsertserverless') {
      const resp = await upsertFunction(credentials, functionName, code)
      if (resp.error) {
        helpers.send_failure(res, resp.error || new Error('unknown err'), 'SystemExtensions', exports.version, 'tasks ' + req.params.task)
      } else {
        helpers.send_success(res, resp)
      }
    } else if (req.params.task === 'createserverless') { // serverless AWS
      const resp = await createFunction(credentials, functionName, code)
      helpers.send_success(res, resp)
    } else if (req.params.task === 'createinvokeserverless') { // serverless AWS
      const resp = await createFunction(credentials, functionName, code)
      if (resp.error) {
        helpers.send_failure(res, resp.error, 'SystemExtensions', exports.version, 'tasks ' + req.params.task)
      } else {
        req.params.task = 'invokeserverless'
        req.params.try2 = true
        setTimeout(() => { exports.tasks(req, res) }, 5000)
      }
    } else { // updateserverless
      const resp = await updateFunction(credentials, functionName, code)
      helpers.send_success(res, resp)
    }
  } else if (req.params.task === 'deleteserverless') {
    const functionName = fullFunctionName(req.freezrAttributes.owner_user_id, req.freezrAttributes.requestor_app, req.freezrAttributes.permission_name)
    if (!functionName) {
      helpers.send_failure(res, new Error('invalid function name 3'), 'SystemExtensions', exports.version, 'tasks ' + req.params.task)
    } else {
      const resp = await deleteFunction(credentials, functionName)
      helpers.send_success(res, resp)
    }
  } else if (req.params.task === 'rolecreateserverless') {
    const role = await exports.createAwsRole(credentials)
    helpers.send_success(res, { status: 'presumed success', role })
  } else if (req.params.task === 'deleterole') {
    helpers.send_failure(res, new Error('service not implemented yet'), 'serverless', exports.version, 'tasks ' + req.params.task)
  } else if (req.params.task === 'upsertextension') {
    const extensionName = req.body?.system_extension_name
    if (!req.file) {
      helpers.send_failure(res, new Error('no file to upsert as a service'), 'serverless', exports.version, 'tasks ' + req.params.task)
    } else if (!extensionName) {
      helpers.send_failure(res, new Error('no service name provided'), 'serverless', exports.version, 'tasks ' + req.params.task)
    } else if (extensionName.indexOf('_') < 0) {
      helpers.send_failure(res, new Error('service name should have one _ and be a zip file'), 'serverless', exports.version, 'tasks ' + req.params.task)
    } else {
      // note only admins can do this
      // DO name checks -> should have one _ and be a zip file..
      req.freezrPublicSystemExtensionsFS.writeToUserFiles(extensionName + '.zip', req.file.buffer, {}, (err) => {
        if (err) {
          helpers.send_failure(res, err, 'serverless', exports.version, 'tasks ' + req.params.task)
        } else {
          exports.reInstallLocalService(req.freezrPublicSystemExtensionsFS, extensionName, function (err) {
            if (err) {
              console.warn('error extracting zip', err)
              helpers.send_failure(res, new Error('no file to upsert as a service'), 'serverless', exports.version, 'tasks ' + req.params.task)
            } else {
              helpers.send_success(res, { status: 'success' })
            }
          })
        }
      })
    }
  } else if (req.params.task === 'serviceexists') { // tbd
    helpers.send_failure(res, new Error('service not implemented yet'), 'serverless', exports.version, 'tasks ' + req.params.task)
  } else if (req.params.task === 'deleteextension') { // tbd
    const extensionName = req.body?.system_extension_name
    if (!extensionName) {
      helpers.send_failure(res, new Error('no service name provided'), 'serverless', exports.version, 'tasks ' + req.params.task)
    } else {
      req.freezrPublicSystemExtensionsFS.removeFile(extensionName + '.zip', {}, (err) => {
        if (err) {
          helpers.send_failure(res, err, 'serverless', exports.version, 'tasks ' + req.params.task)
        } else {
          const folderPath = 'systemextensions' + fileHandler.sep() + extensionName
          fs.rm(folderPath, { recursive: true }, (err) => {
            if (err) {
              helpers.send_failure(res, err, 'serverless', exports.version, 'tasks ' + req.params.task)
            } else {
              helpers.send_success(res, { status: 'success' })
            }
          })
        }
      })
    }
  } else { // tbd
    console.log('other things todo')
    helpers.send_failure(res, new Error('The system extension has not been created by the server admin yet'), 'systemextensions', exports.version, 'tasks ' + req.params.task)
  }
}

exports.createAwsRole = async function (credentials) {
  const iamClient = new IAMClient({
    region: (credentials.region || 'eu-central-1'),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  })
  const command = new CreateRoleCommand({
    AssumeRolePolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Service: 'lambda.amazonaws.com'
          },
          Action: 'sts:AssumeRole'
        }
      ]
    }),
    RoleName: ROLE_NAME
  })
  try {
    const ret = await iamClient.send(command)
    return ret.Role
  } catch (e) {
    console.warn('error creating role', e)
    return { error: e }
  }
}
const createFunction = async function (credentials, functionName, code) {
  const roleArn = credentials.arnRole
  if (!roleArn) {
    // consider creating...
  }
  const lambdaClient = new LambdaClient({
    region: (credentials.region || 'eu-central-1'),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  })

  const command = new CreateFunctionCommand({
    Code: { ZipFile: code },
    FunctionName: functionName,
    Role: roleArn,
    Architectures: [Architecture.arm64],
    Handler: 'index.handler',
    PackageType: PackageType.Zip,
    Runtime: Runtime.nodejs16x
  })

  try {
    const ret = await lambdaClient.send(command)
    return ret
  } catch (e) {
    return { error: e }
  }
}
const updateFunction = async function (credentials, functionName, code) {
  const roleArn = credentials.arnRole
  if (!roleArn) {
    // consider creating...
  }
  const lambdaClient = new LambdaClient({
    region: (credentials.region || 'eu-central-1'),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  })

  const command = new UpdateFunctionCodeCommand({
    ZipFile: code,
    FunctionName: functionName,
    Architectures: [Architecture.arm64],
    Handler: 'index.handler', // Required when sending a .zip file
    PackageType: PackageType.Zip, // Required when sending a .zip file
    Runtime: Runtime.nodejs16x, // Required when sending a .zip file
  })

  try {
    const ret = await lambdaClient.send(command)
    return ret
  } catch (e) {
    return { error: e }
  }
}
const deleteFunction = async function (credentials, functionName, code) {
  const lambdaClient = new LambdaClient({
    region: (credentials.region || 'eu-central-1'),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  })

  const command = new DeleteFunctionCommand({ FunctionName: functionName })

  try {
    const ret = await lambdaClient.send(command)
    return ret
  } catch (e) {
    return { error: e }
  }
}
const getFunction = async function (credentials, functionName, code) {
  const lambdaClient = new LambdaClient({
    region: (credentials.region || 'eu-central-1'),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  })
  const input = { // GetFunctionRequest
    FunctionName: functionName
    // Qualifier: "STRING_VALUE", // can eb used in future for version nums
  }
  const command = new GetFunctionCommand(input)

  try {
    const ret = await lambdaClient.send(command)
    return ret
  } catch (e) {
    return { error: e }
  }
}
const upsertFunction = async function (credentials, functionName, code) {
  if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey || !functionName) return new Error('credentials or aneme missing')
  const getFunc = await getFunction(credentials, functionName, code)
  if (getFunc.Code) { // func exists
    const resp = await updateFunction(credentials, functionName, code)
    return resp
  } else if (getFunc.error?.name === 'ResourceNotFoundException') { // doesn exist
    const resp = await createFunction(credentials, functionName, code)
    return resp
  } else {
    return getFunc.error || new Error('unknown err')
  }
}
const invokeFunction = async function (credentials, functionName, payload) {
  // const client = new LambdaClient({});
  if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
    return { error: 'no credentials' }
  }
  const lambdaClient = new LambdaClient({
    region: (credentials?.region || 'eu-central-1'),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  })
  const invokeCommand = new InvokeCommand({
    FunctionName: functionName,
    Payload: JSON.stringify(payload),
    LogType: LogType.Tail
  })

  try {
    const { Payload, LogResult } = await lambdaClient.send(invokeCommand)
    let result = Buffer.from(Payload).toString()
    const logs = Buffer.from(LogResult, 'base64').toString()
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result)
      } catch (e) {
        console.warn('error parsing result', e)
      }
    }
    return { logs, result }
  } catch (e) {
    console.warn('error invoking code ', e.name)
    return { error: e }
  }
}

const invokeLocally = async function (req, functionName, payload) {
  // onsole.log('invokeLocally', { functionName, payload })
  try {
    const moduleHandler = await import('../systemextensions/' + functionName + '/index.mjs')
    const systemExtensionsRet = await moduleHandler.handler(payload, {})
    return { result: systemExtensionsRet }
  } catch (e) {
    // console.warn('SystemExtensions module missing - going to see if it should be re-installed')
    try {
      const tryReInstall = await reInstalleLocalServiceAsync(req.freezrPublicSystemExtensionsFS, functionName)
      if (tryReInstall.error) throw new Error('could not re-install app')
      const moduleHandler = await import('../systemextensions/' + functionName + '/index.mjs')
      const systemExtensionsRet = await moduleHandler.handler(payload, {})
      return { result: systemExtensionsRet }
    } catch (e) {
      return { error: e }
    }
  }
}

exports.reInstallLocalService = function (freezrPublicSystemExtensionsFS, serviceName, cb) {
  const fileName = serviceName + '.zip'
  // onsole.log('reInstallLocalService', { serviceName, fileName, full: fileHandler.fullLocalPathTo(fileName) })

  freezrPublicSystemExtensionsFS.getUserFile(fileName, { }, (err, data) => {
    if (err) {
      console.warn('error reading file', err)
      return { error: err }
    } else {
      const folderPath = 'systemextensions' + fileHandler.sep() + serviceName
      fileHandler.extractZipToLocalFolder(data, folderPath, serviceName, function (err) {
        cb(null, { error: err, success: !err })
      })
    }
  })
}
const convertToAsync = function (fn) {
  const promise = function () {
    const args = Array.prototype.slice.call(arguments)
    return new Promise(function (resolve, reject) {
      args.push(function (error, resp) {
        if (error || !resp || resp.error) {
          if (!error) error = resp?.error ? resp : new Error('No response from promise')// temp fix todo review
          reject(error)
        } else {
          resolve(resp)
        }
      })
      fn(...args)
    })
  }
  return promise
}
const reInstalleLocalServiceAsync = convertToAsync(exports.reInstallLocalService)
exports.upsertServerlessFuncsOnInstall = async function (req, appNameId, manifestPerms, tempFolderPath) {
  // onsole.log('upsertServerlessFuncsOnInstall in serverless', { appNameId, manifestPerms, tempFolderPath })
  const credentials = req.freezrUserDS.slParams

  try {
    const existingPermList = await req.freezrUserPermsDB.async.query({ requestor_app: appNameId }, {})
    existingPermList.forEach(aPerm => { if (aPerm.status === 'outDated' && aPerm.type === 'use_serverless') manifestPerms.unshift(aPerm) })
  } catch (e) {
    return { error: e }
  }

  const errors = []
  for (const aPerm of manifestPerms) {
    if (aPerm.type === 'use_serverless') {
      let ret = {}
      const functionName = fullFunctionName(req.session.logged_in_user_id, appNameId, aPerm.name)
      if (!functionName) {
        ret = { error: ('could not find functionname for ' + req.session.logged_in_user_idd + ' - ' + appNameId + aPerm.name) }
      } else if (aPerm.status === 'outdated') {
        ret = await deleteFunction(credentials, functionName)
      } else {
        const fullZipPath = fileHandler.fullLocalPathTo(tempFolderPath + fileHandler.sep() + aPerm.name + '.zip')
        let code
        try {
          code = fs.existsSync(fullZipPath) ? fs.readFileSync(fullZipPath) : null
        } catch (e) {
          console.warn('error reading code', e)
          ret = { error: e }
        }
        if (code) ret = await upsertFunction(credentials, functionName, code)
        if (!code && !ret.error) ret = { error: ('could not find code for ' + aPerm.function_name) }
      }
      if (ret.error) errors.push(ret.error)
    } else { /* ignore other perms */ }
  }
  if (errors.length > 0) {
    return { error: 'errors encou tered', errors }
  } else {
    return {}
  }
}

// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('file_handler.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }