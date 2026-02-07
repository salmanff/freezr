// freezr.info - Simple test to check server response
import fetch from 'node-fetch'

const BASE_URL = 'http://localhost:3000'

async function testSimple() {
  console.log('🧪 Testing server response...')
  
  try {
    // Test 1: Check if server is running
    console.log('\n1. Testing server root...')
    const rootResponse = await fetch(`${BASE_URL}/`)
    console.log('Root status:', rootResponse.status)
    console.log('Root headers:', Object.fromEntries(rootResponse.headers.entries()))
    
    // Test 2: Check acctapi/login
    console.log('\n2. Testing /acctapi/login...')
    const apiResponse = await fetch(`${BASE_URL}/acctapi/login`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })
    
    console.log('API status:', apiResponse.status)
    console.log('API headers:', Object.fromEntries(apiResponse.headers.entries()))
    
    const responseText = await apiResponse.text()
    console.log('API response text:', responseText.substring(0, 200) + (responseText.length > 200 ? '...' : ''))
    
    // Test 3: Check legacy route
    console.log('\n3. Testing legacy /v1/account/login...')
    const legacyResponse = await fetch(`${BASE_URL}/v1/account/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_id: 'test',
        password: 'test'
      })
    })
    
    console.log('Legacy status:', legacyResponse.status)
    const legacyText = await legacyResponse.text()
    console.log('Legacy response text:', legacyText.substring(0, 200) + (legacyText.length > 200 ? '...' : ''))
    
  } catch (error) {
    console.error('❌ Test failed:', error.message)
    if (error.code === 'ECONNREFUSED') {
      console.log('💡 Server is not running. Please start the server first:')
      console.log('   node server.js')
    }
  }
}

testSimple()
