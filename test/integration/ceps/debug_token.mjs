/**
 * Debug script to test token acquisition and usage
 * Run with: node test/integration/ceps/debug_token.mjs
 */

import { TestAuthHelper, loadTestCredentials } from './testAuthHelper.mjs'

async function debugToken() {
  console.log('\n🔍 Debug Token Test\n')
  
  const creds = loadTestCredentials()
  const user = creds.users.primary
  const appName = creds.testAppConfig.appName
  const serverUrl = creds.serverUrl
  
  const auth = new TestAuthHelper(serverUrl)
  
  // Step 1: Login
  console.log('1️⃣  Logging in...')
  const loginResult = await auth.login(user.user_id, user.password)
  console.log(`   Status: ${loginResult.status}`)
  console.log(`   Success: ${loginResult.success}`)
  console.log(`   Cookies after login: ${Object.keys(auth.cookies).join(', ')}`)
  console.log(`   App token after login: ${auth.appToken ? 'YES' : 'NO'}`)
  
  if (!loginResult.success) {
    console.error('❌ Login failed')
    return
  }
  
  // Step 2: Visit app page
  console.log('\n2️⃣  Visiting app page...')
  await auth.visitAppPage(appName)
  console.log(`   Cookies after visit: ${Object.keys(auth.cookies).join(', ')}`)
  console.log(`   App token after visit: ${auth.appToken ? auth.appToken.substring(0, 30) + '...' : 'NO'}`)
  
  // Step 3: Try ping
  console.log('\n3️⃣  Testing /ceps/ping...')
  const pingResponse = await auth.get('/ceps/ping')
  console.log(`   Status: ${pingResponse.status}`)
  console.log(`   Response: ${JSON.stringify(pingResponse.data).substring(0, 100)}`)
  
  // Step 4: Try write
  console.log('\n4️⃣  Testing /ceps/write...')
  const writeResponse = await auth.post(`/ceps/write/${creds.testAppConfig.appTable}`, {
    test: 'debug',
    timestamp: Date.now()
  })
  console.log(`   Status: ${writeResponse.status}`)
  console.log(`   Response: ${JSON.stringify(writeResponse.data)}`)
  
  // Step 5: Check token details
  console.log('\n5️⃣  Token Details:')
  console.log(`   User ID: ${auth.userId}`)
  console.log(`   App Name: ${auth.appName}`)
  console.log(`   App Token: ${auth.appToken ? auth.appToken : 'NONE'}`)
  console.log(`   All cookies:`)
  for (const [name, value] of Object.entries(auth.cookies)) {
    console.log(`     ${name}: ${value.substring(0, 30)}${value.length > 30 ? '...' : ''}`)
  }
}

debugToken().catch(err => {
  console.error('❌ Error:', err)
})
