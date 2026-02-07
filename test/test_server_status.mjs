// freezr.info - Test server status and routes
import fetch from 'node-fetch'

const BASE_URL = 'http://localhost:3000'

async function testServerStatus() {
  console.log('🧪 Testing server status and route mounting...')
  
  try {
    // Test 1: Check if server is running
    console.log('\n1. Testing server root...')
    const rootResponse = await fetch(`${BASE_URL}/`)
    console.log('Root status:', rootResponse.status)
    
    // Test 2: Check if modern routes are mounted
    console.log('\n2. Testing /acctapi/test...')
    const testResponse = await fetch(`${BASE_URL}/acctapi/test`)
    console.log('Test status:', testResponse.status)
    
    if (testResponse.status === 200) {
      const testData = await testResponse.json()
      console.log('Test response:', testData)
    } else {
      const testText = await testResponse.text()
      console.log('Test response text:', testText.substring(0, 200))
    }
    
    // Test 3: Check legacy route
    console.log('\n3. Testing legacy /v1/account/login...')
    const legacyResponse = await fetch(`${BASE_URL}/v1/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'test', password: 'test' })
    })
    console.log('Legacy status:', legacyResponse.status)
    const legacyText = await legacyResponse.text()
    console.log('Legacy response:', legacyText.substring(0, 100))
    
    // Test 4: Check if server has modern route mounting logs
    console.log('\n4. Server should show "Modern account API routes mounted at /acctapi" in logs')
    console.log('   If you don\'t see this message, the server needs to be restarted')
    
  } catch (error) {
    console.error('❌ Test failed:', error.message)
  }
}

testServerStatus()
