/*
serverless.mjs 
TODO-MODERNIZATION - this as created so that installAp runs, but has NOT been tested.. needs to be reviewed compted to old versions and tested
Modern ES6 Module - Serverless and local 3P functions compute adapter

Currently only with AWS - needs to be abstracted to cover other serverless service providers
It needs to be abstracted to use various ckloud providers

Architecture Pattern:
- Adapter layer for serverless functions (AWS Lambda, local services)
- Uses modern res.locals.freezr instead of req.freezrAttributes
- Uses modern async database methods (db.query instead of db.async.query)
- Uses modern response helpers from adapters/http/responses.mjs
- Uses modern file system methods

Location: adapters/compute/
- This is an ADAPTER because it interfaces between the application and compute services
*/

import fs from 'fs'
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

// Import modern response helpers
import { sendApiSuccess, sendFailure } from '../../http/responses.mjs'

// Import modern utils
import { endsWith } from '../../../common/helpers/utils.mjs'

const ROLE_NAME = 'freezrLambdaRole'

export const version = '0.0.1'
export const ADMIN_FUNCTIONS = ['upsertlocalservice', 'deletelocalfunction', 'getalllocalfunctions']
export const LOCAL_FUNCTIONS = [...ADMIN_FUNCTIONS, 'invokelocalservice']
export const CLOUD_CREATION_FUNCS = ['createserverless', 'createinvokeserverless', 'upsertserverless', 'updateserverless']
export const CLOUD_FUNCTIONS = [...CLOUD_CREATION_FUNCS, 'invokeserverless', 'deleteserverless', 'deleterole']

const fullFunctionNameForCloud = function (ownerName, appName, pureFunctionName) {
  // full name is used on the serverless system just to differentiate between potential different versions and show it is a freezr service
  if (!ownerName || !appName || !pureFunctionName) return null
  const ret1 = ('freezr_' + ownerName + '_' + appName + '_' + pureFunctionName).replace(/\./g, '_')
  return ret1.slice(0, 64)  // AWS constraint of 64 chars
}

/**
 * Main tasks handler for serverless functions
 * Modernized to use res.locals.freezr instead of req.freezrAttributes
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const tasks = async function (req, res) {
  try {
    const freezr = res.locals?.freezr
    if (!freezr) {
      return sendFailure(res, 'Freezr context not available', 'serverless.tasks', 500)
    }

    const tokenInfo = freezr.tokenInfo
    if (!tokenInfo) {
      return sendFailure(res, 'Token info not available', 'serverless.tasks', 401)
    }

    const userDS = freezr.userDS
    if (!userDS || !userDS.slParams) {
      return sendFailure(res, 'User data store or serverless params not available', 'serverless.tasks', 500)
    }

    const credentials = userDS.slParams // Todo-modernization - this was stored in freezrAttributes
    const task = req.params.task

    const permission = freezr.permission // already grabted and with specific name so only type needs to be checked
    if (!permission) {
      if (ADMIN_FUNCTIONS.includes(req.params.task) && tokenInfo.app_name === 'info.freezr.admin' && req.session.logged_in_as_admin) {
        // console.log('okay for admin to upsert localservice (2)')
      } else {
        return sendFailure(res, 'Permission not available', 'serverless.tasks', 500)
      }
    } else if (ADMIN_FUNCTIONS.includes(task)) {
      // console.log('ADMIN_FUNCTIONS.includes(task)', { task, permission })
      if (!req.session.logged_in_as_admin || (permission.type !== 'use_3pFunction' && permission.type !== 'auto_update_local_3pFunction')) {
        return sendFailure(res, 'use_3pFunction or auto_update_local_3pFunction Permission not available', 'serverless.tasks', 403)
      }
    } else if (LOCAL_FUNCTIONS.includes(task)) {
      // console.log('LOCAL_FUNCTIONS.includes(task)', { task, type: permission.type, permission })
      if (permission.type !== 'use_3pFunction') {
        return sendFailure(res, 'use_3pFunction Permission not available', 'serverless.tasks', 403)
      }
    } else if (CLOUD_FUNCTIONS.includes(task)) {
      if (permission.type !== 'use_serverless') {
        return sendFailure(res, 'use_serverless Permission not available', 'serverless.tasks', 403)
      }
    } else {
      return sendFailure(res, 'Invalid task', 'serverless.tasks', 400)
    }
    
    if (task === 'upsertlocalservice') {
      return await handleUpsertLocalService(req, res, freezr)
    } else if (task === 'invokelocalservice') {
      return await handleInvoke(req, res, freezr, credentials, task)
    } else if (task === 'localserviceexists') {
      return sendFailure(res, 'Service not implemented yet', 'serverless.tasks', 501)
    } else if (task === 'getalllocalfunctions') {
      return await handleGetAllLocalFunctions(req, res, freezr)
    } else if (task === 'deletelocalfunction') {
      return await handleDeleteLocalFunction(req, res, freezr)
    } else if (CLOUD_CREATION_FUNCS.includes(task)) {
      return await handleCreateOrUpdateCloudService(req, res, freezr, credentials, task)
    } else if (task === 'invokeserverless') {
      return await handleInvoke(req, res, freezr, credentials, task)
    } else if (task === 'deleteserverless') {
      return await handleDeleteServerlessFunction(req, res, freezr, credentials)
    } else if (task === 'rolecreateserverless') {
      return await handleCreateRole(req, res, credentials)
    } else if (task === 'deleterole') {
      return sendFailure(res, 'Service not implemented yet', 'serverless.tasks', 501)
    } else {
      return sendFailure(res, 'The system microservice has not been created by the server admin yet', 'serverless.tasks', 501)
    }
  } catch (error) {
    console.error('❌ Error in serverless.tasks:', error)
    return sendFailure(res, error, 'serverless.tasks', 500)
  }
}

/**
 * Handle invoke serverless or local service
 */
const handleInvoke = async (req, res, freezr, credentials, task) => {
  // console.log('handleInvoke', { task, freezr })
  const tokenInfo = freezr.tokenInfo
  const functionName = freezr.functionName
  
  const fullFunctionName = task === 'invokelocalservice'
    ? functionName
    : fullFunctionNameForCloud(tokenInfo.owner_id, tokenInfo.app_name, functionName)

  if (!functionName || !fullFunctionName) {
    return sendFailure(res, 'Invalid function name', 'serverless.handleInvoke', 400)
  }

  const payload = { inputParams: req.body.inputParams }

  if (req.file) {
    payload.file = req.file
  }

  // Handle database reads if requested
  if (req.body.read_collection_name && freezr.freezrDbs) {
    payload.dbResults = {}
    try {
      const db = freezr.freezrDbs[req.body.read_collection_name]
      if (db) {
        const dbResults = await db.query(req.body.read_query, {})
        payload.dbResults[req.body.read_name] = dbResults
      }
    } catch (e) {
      console.warn('Error getting dbInput - allowing function to run for ' + permissionName, e)
    }
  }

  const resp = task === 'invokeserverless'
    ? await invokeCloudFunction(credentials, fullFunctionName, payload)
    : await invokeLocally(req, freezr, functionName, payload)

  // console.log('handleInvoke resp', { resp, result: resp?.result, apiResponse: resp?.result?.apiResponse })

  if (resp.error) {
    if (resp.error.name === 'ResourceNotFoundException' && !req.params.try2) {
      req.params.task = 'createinvokeserverless'
      return tasks(req, res)
    } else {
      console.error('handleInvoke error', { resp })
      return sendFailure(res, resp.error, 'serverless.handleInvoke', 500)
    }
  }

  if (!resp) {
    return sendFailure(res, 'No response from function', 'serverless.handleInvoke', 500)
  }

  if (!resp?.result?.apiResponse) {
    // console.log('No apiResponse provided', { resp })
    resp.result.apiResponse = { error: resp.result.error || 'internal error - no apiResponse provided' }
  }
  if (resp.result?.dbWrite) {
    resp.result.apiResponse.dbWrite = 'dbWrite not implemented yet'
  } else if (resp.result?.fileSave) {
    resp.result.apiResponse.fileSave = 'fileSave not implemented yet'
  }

  // console.log('Now sending', { apiResponse: resp.result.apiResponse })

  return sendApiSuccess(res, resp.result.apiResponse)
}

/**
 * Invoke Lambda function
 */
const invokeCloudFunction = async function (credentials, fullFunctionName, payload) {
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
    FunctionName: fullFunctionName,
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
        console.error('invokeCloudFunction error', { e })
        error = e
      }
    }
    // console.log('invokeCloudFunction result', { logs, result, error })
    return { logs, result, error }
  } catch (e) {
    return { error: e }
  }
}

/**
 * Invoke local 3P Function
 */
const invokeLocally = async function (req, freezr, functionName, payload) {
  try {
    const moduleHandler = await import('../../../users_3Pfunctions/' + functionName + '/index.mjs')
    const thirdPartyFunctionsRet = await moduleHandler.handler(payload, {})
    return { result: thirdPartyFunctionsRet }
  } catch (e) {
    console.warn('3P Function module missing - going to see if it should be re-installed', { functionName, e })
    try {
      const thirdPartyFunctionsFS = freezr.thirdPartyFunctionsFS
      if (!thirdPartyFunctionsFS) {
        throw new Error('Public 3Pfunctions file system not available')
      }
      const tryReInstall = await unzipServiceToPublicLocalFile(thirdPartyFunctionsFS, functionName)
      if (tryReInstall.error) throw new Error('could not re-install 3P Function')
      const moduleHandler = await import('../../../users_3Pfunctions/' + functionName + '/index.mjs')
      const thirdPartyFunctionsRet = await moduleHandler.handler(payload, {})
      return { result: thirdPartyFunctionsRet }
    } catch (e) {
      console.error('invokeLocally error', { e })
      return { error: e }
    }
  }
}

/**
 * Handle upsert local service
 */
const handleUpsertLocalService = async (req, res, freezr) => {
  if (!req.file) {
    return sendFailure(res, 'No file to upsert as a service', 'serverless.handleUpsertLocalService', 400)
  }

  const thirdPartyFunctionFileName = req.file.originalname // req.body?.thirdPartyFunctionName
  
  if (thirdPartyFunctionFileName.indexOf('_') < 0 || !endsWith(thirdPartyFunctionFileName,'.zip')) {
    console.error('Service name should have one _ and be a zip file', { thirdPartyFunctionFileName })
    return sendFailure(res, 'Service name should have one _ and be a zip file', 'serverless.handleUpsertLocalService', 400)
  }

  const thirdPartyFunctionsFS = freezr.thirdPartyFunctionsFS
  if (!thirdPartyFunctionsFS) {
    return sendFailure(res, 'Public 3Pfunctions file system not available', 'serverless.handleUpsertLocalService', 500)
  }

  try {
    // service zip file is stored in public user files and extrcted to local folder for use
    await thirdPartyFunctionsFS.writeToUserFiles(thirdPartyFunctionFileName, req.file.buffer, {})
    
    // Reinstall local service
    await unzipServiceToPublicLocalFile(thirdPartyFunctionsFS, thirdPartyFunctionFileName)
    
    return sendApiSuccess(res, { status: 'success' })
  } catch (error) {
    return sendFailure(res, error, 'serverless.handleUpsertLocalService', 500)
  }
}

const handleGetAllLocalFunctions = async (req, res, freezr) => {
  const thirdPartyFunctionsFS = freezr.thirdPartyFunctionsFS
  if (!thirdPartyFunctionsFS) {
    return sendFailure(res, 'Public 3Pfunctions file system not available', 'serverless.handleGetLocalFunctions', 500)
  }
  let localFunctions = await thirdPartyFunctionsFS.readUserDir()
  if (localFunctions && localFunctions.length > 0) {
    localFunctions = localFunctions
      .filter(file => endsWith(file, '.zip'))
      .map(file => file.replace(/\.zip$/, ''))
  }
  return sendApiSuccess(res, { localFunctions })
}

/**
 * Handle delete serverless
 */
const handleDeleteLocalFunction = async (req, res, freezr) => {
  const thirdPartyFunctionName = req.body?.thirdPartyFunctionName
  
  if (!thirdPartyFunctionName) {
    return sendFailure(res, 'No service name provided', 'serverless.handleDeleteLocalFunction', 400)
  }

  const thirdPartyFunctionsFS = freezr.thirdPartyFunctionsFS
  if (!thirdPartyFunctionsFS) {
    return sendFailure(res, 'Public 3Pfunctions file system not available', 'serverless.handleDeleteLocalFunction', 500)
  }

  try {
    // Use modern async removeFile method
    await thirdPartyFunctionsFS.removeFile(thirdPartyFunctionName + '.zip', {})
    
    const folderPath = 'users_3Pfunctions' + sep() + thirdPartyFunctionName
    await fs.promises.rm(folderPath, { recursive: true })
    
    return sendApiSuccess(res, { status: 'success' })
  } catch (error) {
    return sendFailure(res, error, 'serverless.handleDeleteLocalFunction', 500)
  }
}


/**
 * Handle create or update serverless function
 */
const handleCreateOrUpdateCloudService = async (req, res, freezr, credentials, task) => {
  const tokenInfo = freezr.tokenInfo
  const permissionName = tokenInfo.permission_name || req.body?.permission_name
  const functionName = freezr.functionName

  
  if (!functionName) {
    return sendFailure(res, 'Invalid function name', 'serverless.handleCreateOrUpdate', 400)
  }

  const fullFunctionName = fullFunctionNameForCloud(tokenInfo.owner_id, tokenInfo.app_name, functionName)
  let code = null
  let readError = null
  
  try {
    const appFS = freezr.appFS
    if (appFS) {
      // Use modern async readAppFile method
      code = await appFS.readAppFile(functionName + '.zip', { doNotToString: true })
    }
  } catch (e) {
    readError = e
  }

  if (!code) {
    if (readError) {
      return sendFailure(res, readError, 'serverless.handleCreateOrUpdate', 500)
    } else {
      return sendFailure(res, 'Could not read function code', 'serverless.handleCreateOrUpdate', 500)
    }
  }

  if (task === 'upsertserverless') {
    const resp = await upsertFunction(credentials, fullFunctionName, code)
    // console.log('upsertFunction resp', { resp })
    if (resp.error) {
      return sendFailure(res, resp.error || new Error('unknown error'), 'serverless.handleCreateOrUpdate', 500)
    } else {
      return sendApiSuccess(res, resp)
    }
  } else if (task === 'createserverless') {
    const resp = await createFunction(credentials, fullFunctionName, code)
    return sendApiSuccess(res, resp)
  } else if (task === 'createinvokeserverless') {
    const resp = await upsertFunction(credentials, fullFunctionName, code)
    // console.log('createinvokeserverless upsertFunction resp', { resp })
    if (resp.error) {
      console.error('createFunction error', { resp, error: resp.error })
      return sendFailure(res, resp.error, 'serverless.handleCreateOrUpdate', 500)
    } else {
      setTimeout(() => {
        // console.log('createinvokeserverless - invoking function', { fullFunctionName })
        return handleInvoke(req, res, freezr, credentials, 'invokeserverless')
      }, 5000)
      return
    }
  } else { // updateserverless
    const resp = await updateFunction(credentials, fullFunctionName, code)
    return sendApiSuccess(res, resp)
  }
}

/**
 * Handle delete serverless function
 */
const handleDeleteServerlessFunction = async (req, res, freezr, credentials) => {
  const tokenInfo = freezr.tokenInfo
  const permissionName = tokenInfo.permission_name || req.body?.permission_name

  const thePerm = res.locals.freezr.permission

  if (!thePerm) {
    console.warn('No permission found at all for serverless function', { permissionName, thePerm, freezr: res.locals.freezr })
    return sendFailure(res, 'No permission found at all for serverless function', 'serverless.handleDeleteServerlessFunction', 403)
  }
  
  const functionName = fullFunctionName(res.locals.freezr.tokenInfo.owner_user_id, res.locals.freezr.tokenInfo.app_name, permissionName)
  if (!functionName) {
    return sendFailure(res, 'Invalid function name', 'serverless.handleDeleteServerlessFunction', 400)
  }
  const resp = await deleteLambdaFunction(credentials, functionName)
  return sendApiSuccess(res, resp)
}

/**
 * Handle create AWS role
 */
const handleCreateRole = async (req, res, credentials) => {
  const role = await createAwsRole(credentials)
  return sendApiSuccess(res, { status: 'presumed success', role })
}

/**
 * Create AWS IAM role for Lambda
 */
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

/**
 * Create Lambda function
 */
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

/**
 * Update Lambda function code
 */
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

/**
 * Delete Lambda function
 */
const deleteLambdaFunction = async function (credentials, functionName, code) {
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

/**
 * Get Lambda function
 */
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
    // Qualifier: "STRING_VALUE", // can be used in future for version nums
  }
  const command = new GetFunctionCommand(input)

  try {
    const ret = await lambdaClient.send(command)
    return ret
  } catch (e) {
    return { error: e }
  }
}

/**
 * Upsert Lambda function (create if doesn't exist, update if it does)
 */
const upsertFunction = async function (credentials, fullFunctionName, code) {
  if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey || !fullFunctionName) {
    return new Error('credentials or name missing')
  }
  // console.log('upsertFunction', { credentials, fullFunctionName, code })
  const getFunc = await getFunction(credentials, fullFunctionName, code)
  if (getFunc.Code) { // func exists
    const resp = await updateFunction(credentials, fullFunctionName, code)
    return resp
  } else if (getFunc.error?.name === 'ResourceNotFoundException') { // doesn't exist
    const resp = await createFunction(credentials, fullFunctionName, code)
    return resp
  } else {
    return getFunc.error || new Error('unknown error')
  }
}


/**
 * Reinstall local service
 */
export const unzipServiceToPublicLocalFile = async function (freezrthirdPartyFunctionsFS, serviceName) {
  try {
    const fileName = serviceName + (endsWith(serviceName, '.zip') ? '' : '.zip')
    // Strip .zip extension for folder name
    const folderName = endsWith(serviceName, '.zip') ? serviceName.slice(0, -4) : serviceName
    const zipBuffer = await freezrthirdPartyFunctionsFS.getUserFile(fileName, { returnBuffer: true })
    const folderPath = 'users_3Pfunctions' + sep() + folderName
    const ret = await extractZipToLocalFolder(zipBuffer, folderPath, folderName)
    return { success: true }
  } catch (e) {
    console.error('unzipServiceToPublicLocalFile error', { e })
    return { error: e }
  }
}



/**
 * Upsert serverless functions on app install
 * Modernized to use modern naming and async patterns
 */
export const upsertServerlessFuncsOnInstall = async function (context, manifestPerms, tempFolderPath) {
  // Use modern naming: userDS instead of freezrUserDS, userPermsDb instead of freezrUserPermsDB
  const userDS = context.userDS || context.freezrUserDS // Support both old and new naming
  const userPermsDb = context.userPermsDb || context.freezrUserPermsDB // Support both old and new naming
  
  if (!userDS || !userDS.slParams) {
    return { error: 'User data store or serverless params not available' }
  }
  
  const credentials = userDS.slParams
  const appNameId = context.realAppName

  try {
    // Use modern async pattern - databases have query as async method directly
    const existingPermList = await userPermsDb.query({ requestor_app: appNameId }, {})
    existingPermList.forEach(aPerm => { 
      if (aPerm.status === 'outDated' && aPerm.type === 'auto_update_local_3pFunction') {
        manifestPerms.unshift(aPerm)
      }
    })
  } catch (e) {
    return { error: e }
  }

  const errors = []
  for (const aPerm of manifestPerms) {
    if (aPerm.type === 'auto_update_local_3pFunction') {
      let ret = {}
      const funcName = (aPerm.functionName || aPerm.name)
      const fileName = funcName + '.zip'
      if (!funcName) {
        ret = { error: ('could not find functionname for ' + context.userId + ' - ' + appNameId + aPerm.name) }
      } else if (aPerm.status === 'outdated') {
        ret = await deleteLambdaFunction(credentials, funcName)
      } else {
        const fullZipPath = fullLocalPathTo(tempFolderPath + sep() + fileName)
        let code
        try {
          code = fs.existsSync(fullZipPath) ? fs.readFileSync(fullZipPath) : null
        } catch (e) {
          ret = { error: e }
        }
        if (code) ret = await upsertFunction(credentials, funcName, code)
        if (!code && !ret.error) ret = { error: ('could not find code for ' + appNameId) }
      }
      if (ret.error) errors.push(ret.error)
    } else { /* ignore other perms */ }
  }
  if (errors.length > 0) {
    return { error: 'errors encountered', errors }
  } else {
    return {}
  }
}

