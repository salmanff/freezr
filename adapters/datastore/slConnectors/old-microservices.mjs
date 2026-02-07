/* 
THIS IS THE OLD VERSION  DO NOT USE THIS FILE
microservices.mjs
serverless and other local addons

currently only with AWS - needs tobe abstracted to cover other serverless service providers

*/

// Import Node.js standard modules using ES module syntax
import fs from 'fs'

// Import AWS SDK modules using ES module syntax
import {
  LambdaClient,
  LogType,
  InvokeCommand,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  GetFunctionCommand,
  DeleteFunctionCommand,
  Architecture, PackageType, Runtime
} from '@aws-sdk/client-lambda'

import {
  IAMClient, CreateRoleCommand
} from '@aws-sdk/client-iam'

// Import modern file handler
import { sep, extractZipToLocalFolder, fullLocalPathTo } from '../fsConnectors/fileHandler.mjs'

// Import modern response functions
import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'

const ROLE_NAME = 'freezrLambdaRole'

export const version = '0.0.1'
export const LOCAL_FUNCTIONS = ['invokelocalservice', 'upsertlocalservice', 'deletemicroservice']
export const ADMIN_FUNCTIONS = ['upsertlocalservice', 'deletemicroservice']

const fullFunctionName = function (ownerName, appName, pureFunctionName) {
  // full name is used on the serverless system just to differentiate between potential different versions and show it is a freezr service
  // if (!ownerName || !appName || !pureFunctionName) console.log('oneof three params missing ', { ownerName, appName, pureFunctionName } )
  if (!ownerName || !appName || !pureFunctionName) return null
  const ret1 = ('freezr_' + ownerName + '_' + appName + '_' + pureFunctionName).replace(/\./g, '_')
  return ret1.slice(0, 64)  // ('freezr_' + ownerName + '_' + appName + '_' + pureFunctionName).replace(/\./g, '_').slice(64) // aws contraint of 64 chars
}

export const tasks = async function (req, res) {
  // onsole.log('tasks', { tasl: req.params.task, body: req.body, query: req.query, freezrAttributes: req.freezrAttributes })
  const credentials = req.freezrAttributes.slParams

  if (req.params.task === 'invokeserverless' || req.params.task === 'invokelocalservice') {
    const functionName = req.params.task === 'invokelocalservice'
      ? req.body?.permission_name
      : fullFunctionName(req.freezrAttributes.owner_user_id, req.freezrAttributes.requestor_app, req.body?.permission_name)
    if (req.freezrAttributes.permission_name !== req.body?.permission_name) {
      return sendFailure(res, new Error('permission name mismatch'), `serverless.tasks.${req.params.task}`, 400)
    } else if (!functionName) {
      return sendFailure(res, new Error('invalid function name 1'), `serverless.tasks.${req.params.task}`, 400)
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
          return tasks(req, res)
        } else {
          return sendFailure(res, resp.error, `serverless.tasks.${req.params.task}`, 500)
        }
      } else if (!resp) {
        return sendFailure(res, new Error('no response'), `serverless.tasks.${req.params.task}`, 500)
      } else {
        if (!resp.result) resp.result = {}
        if (!resp.result.apiResponse) { resp.result.apiResponse = { error: resp.result.error || 'internal error - no apiResponse provided' } }
        if (resp.result?.dbWrite) {
          resp.result.apiResponse.dbWrite = 'dbWrite not implemented yet'
        } else if (resp.result?.fileSave) {
          resp.result.apiResponse.fileSave = 'fileSave not implemented yet'
        }
        return sendApiSuccess(res, resp.result.apiResponse)
      }
    }
  } else if (['createserverless', 'createinvokeserverless', 'upsertserverless', 'updateserverless'].indexOf(req.params.task) > -1) { // for serverless functions
    const functionName = fullFunctionName(req.freezrAttributes.owner_user_id, req.freezrAttributes.requestor_app, req.freezrAttributes.permission_name)
    let code
    try {
      code = req.freezrAppFS ? await req.freezrAppFS.async.readAppFile(req.freezrAttributes.permission_name + '.zip', { doNotToString: true }) : null
    } catch (e) {
      req.freezrAppFSError = e
    }

    if (!functionName) {
      return sendFailure(res, new Error('invalid function name 2'), `Microservices.tasks.${req.params.task}`, 400)
    } else if (!code) {
      if (req.freezrAppFSError) {
        return sendFailure(res, req.freezrAppFSError, `Microservices.tasks.${req.params.task}`, 500)
      } else {
        return sendFailure(res, new Error('could not read function code'), `Microservices.tasks.${req.params.task}`, 500)
      }
    } else if (req.params.task === 'upsertserverless') {
      const resp = await upsertFunction(credentials, functionName, code)
      if (resp.error) {
        return sendFailure(res, resp.error || new Error('unknown err'), `Microservices.tasks.${req.params.task}`, 500)
      } else {
        return sendApiSuccess(res, resp)
      }
    } else if (req.params.task === 'createserverless') { // serverless AWS
      const resp = await createFunction(credentials, functionName, code)
      return sendApiSuccess(res, resp)
    } else if (req.params.task === 'createinvokeserverless') { // serverless AWS
      const resp = await createFunction(credentials, functionName, code)
      if (resp.error) {
        return sendFailure(res, resp.error, `Microservices.tasks.${req.params.task}`, 500)
      } else {
        req.params.task = 'invokeserverless'
        req.params.try2 = true
        setTimeout(() => { tasks(req, res) }, 5000)
      }
    } else { // updateserverless
      const resp = await updateFunction(credentials, functionName, code)
      return sendApiSuccess(res, resp)
    }
  } else if (req.params.task === 'deleteserverless') {
    const functionName = fullFunctionName(req.freezrAttributes.owner_user_id, req.freezrAttributes.requestor_app, req.freezrAttributes.permission_name)
    if (!functionName) {
      return sendFailure(res, new Error('invalid function name 3'), `Microservices.tasks.${req.params.task}`, 400)
    } else {
      const resp = await deleteFunction(credentials, functionName)
      return sendApiSuccess(res, resp)
    }
  } else if (req.params.task === 'rolecreateserverless') {
    const role = await createAwsRole(credentials)
    return sendApiSuccess(res, { status: 'presumed success', role })
  } else if (req.params.task === 'deleterole') {
    return sendFailure(res, new Error('service not implemented yet'), `serverless.tasks.${req.params.task}`, 501)
  } else if (req.params.task === 'upsertlocalservice') {
    const microserviceName = req.body?.microserviceName
    if (!req.file) {
      return sendFailure(res, new Error('no file to upsert as a service'), `serverless.tasks.${req.params.task}`, 400)
    } else if (!microserviceName) {
      return sendFailure(res, new Error('no service name provided'), `serverless.tasks.${req.params.task}`, 400)
    } else if (microserviceName.indexOf('_') < 0) {
      return sendFailure(res, new Error('service name should have one _ and be a zip file'), `serverless.tasks.${req.params.task}`, 400)
    } else {
      // note only admins can do this
      // DO name checks -> should have one _ and be a zip file..
      req.freezrPublicMicroservicesFS.writeToUserFiles(microserviceName + '.zip', req.file.buffer, {}, (err) => {
        if (err) {
          sendFailure(res, err, `serverless.tasks.${req.params.task}`, 500)
        } else {
          reInstallLocalService(req.freezrPublicMicroservicesFS, microserviceName, function (err) {
            if (err) {
              sendFailure(res, new Error('no file to upsert as a service'), `serverless.tasks.${req.params.task}`, 500)
            } else {
              sendApiSuccess(res, { status: 'success' })
            }
          })
        }
      })
    }
  } else if (req.params.task === 'serviceexists') { // tbd
    return sendFailure(res, new Error('service not implemented yet'), `serverless.tasks.${req.params.task}`, 501)
  } else if (req.params.task === 'deletemicroservice') { // tbd
    const microserviceName = req.body?.microserviceName
    if (!microserviceName) {
      return sendFailure(res, new Error('no service name provided'), `serverless.tasks.${req.params.task}`, 400)
    } else {
      req.freezrPublicMicroservicesFS.removeFile(microserviceName + '.zip', {}, (err) => {
        if (err) {
          sendFailure(res, err, `serverless.tasks.${req.params.task}`, 500)
        } else {
          const folderPath = 'usermicroservices' + sep() + microserviceName
          fs.rm(folderPath, { recursive: true }, (err) => {
            if (err) {
              sendFailure(res, err, `serverless.tasks.${req.params.task}`, 500)
            } else {
              sendApiSuccess(res, { status: 'success' })
            }
          })
        }
      })
    }
  } else { // tbd
    return sendFailure(res, new Error('The system microservice has not been created by the server admin yet'), `usermicroservices.tasks.${req.params.task}`, 501)
  }
}

export const createAwsRole = async function (credentials) {
  const iamClient = new IAMClient({
    region: (credentials.region || 'eu-central-1'),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  })
  const command = new CreateRoleCommand({
    RoleName: ROLE_NAME,
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
    })
  })

  try {
    const ret = await iamClient.send(command)
    return ret?.Role
  } catch (e) {
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
    Handler: 'index.handler',
    PackageType: PackageType.Zip,
    Runtime: Runtime.nodejs16x,
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
    let error = null
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result)
      } catch (e) {
        error = e
      }
    }
    return { logs, result, error }
  } catch (e) {
    return { error: e }
  }
}

const invokeLocally = async function (req, functionName, payload) {
  // onsole.log('invokeLocally', { functionName, payload })
  try {
    const moduleHandler = await import('../usermicroservices/' + functionName + '/index.mjs')
    const microservicesRet = await moduleHandler.handler(payload, {})
    return { result: microservicesRet }
  } catch (e) {
    console.warn('Microservices module missing - going to see if it should be re-installed', { e })
    try {
      const tryReInstall = await reInstalleLocalServiceAsync(req.freezrPublicMicroservicesFS, functionName)
      if (tryReInstall.error) throw new Error('could not re-install app')
      const moduleHandler = await import('../usermicroservices/' + functionName + '/index.mjs')
      const microservicesRet = await moduleHandler.handler(payload, {})
      return { result: microservicesRet }
    } catch (e) {
      return { error: e }
    }
  }
}

export const reInstallLocalService = function (freezrPublicMicroservicesFS, serviceName, cb) {
  const fileName = serviceName + '.zip'
  // onsole.log('reInstallLocalService', { serviceName, fileName, full: fileHandler.fullLocalPathTo(fileName) })

  freezrPublicMicroservicesFS.getUserFile(fileName, { }, (err, data) => {
    if (err) {
      return { error: err }
    } else {
      const folderPath = 'usermicroservices' + sep() + serviceName
      extractZipToLocalFolder(data, folderPath, serviceName, function (err) {
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

const reInstalleLocalServiceAsync = convertToAsync(reInstallLocalService)

export const upsertServerlessFuncsOnInstall = async function (context, manifestPerms, tempFolderPath) {
  // onsole.log('upsertServerlessFuncsOnInstall in serverless', { manifestPerms, tempFolderPath })
  const credentials = context.freezrUserDS.slParams
  const appNameId = context.realAppName

  try {
    const existingPermList = await context.freezrUserPermsDB.async.query({ requestor_app: appNameId }, {})
    existingPermList.forEach(aPerm => { if (aPerm.status === 'outDated' && aPerm.type === 'use_microservice') manifestPerms.unshift(aPerm) })
  } catch (e) {
    return { error: e }
  }

  const errors = []
  for (const aPerm of manifestPerms) {
    if (aPerm.type === 'use_microservice') {
      let ret = {}
      const functionName = fullFunctionName(context.userId, appNameId, aPerm.name)
      if (!functionName) {
        ret = { error: ('could not find functionname for ' + context.userId + ' - ' + appNameId + aPerm.name) }
      } else if (aPerm.status === 'outdated') {
        ret = await deleteFunction(credentials, functionName)
      } else {
        const fullZipPath = fullLocalPathTo(tempFolderPath + sep() + aPerm.name + '.zip')
        let code
        try {
          code = fs.existsSync(fullZipPath) ? fs.readFileSync(fullZipPath) : null
        } catch (e) {
          ret = { error: e }
        }
        if (code) ret = await upsertFunction(credentials, functionName, code)
        if (!code && !ret.error) ret = { error: ('could not find code for ' + appNameId) }
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
const felog = function (...args) { if (LOG_ERRORS) console.warn('[microservices.mjs]', ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) } 