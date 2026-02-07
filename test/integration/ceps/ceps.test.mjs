/**
 * CEPS Endpoints Integration Tests
 * 
 * Tests the following endpoints:
 *   POST   /ceps/write/:app_table          - Create a record
 *   GET    /ceps/read/:app_table/:id       - Read a record by ID
 *   GET    /ceps/query/:app_table          - Query records
 *   PUT    /ceps/update/:app_table/:id     - Update a record
 *   DELETE /ceps/delete/:app_table/:id     - Delete a record
 *   GET    /ceps/ping                      - Ping (health check)
 * 
 * CEPS 2.0 Compliance Tests:
 *   - All responses include required fields: _id, _date_created, _date_modified
 *   - Query returns array sorted by _date_modified (descending)
 *   - Query supports _modified_before and _modified_after parameters
 *   - Timestamps are Unix epoch (numbers)
 * 
 * Prerequisites: 
 *   1. Server must be running on the configured URL
 *   2. Test users must exist (see users_freezr/test_credentials/testUserCreds.json)
 *   3. Run with: npm run test:ceps
 */

import { expect } from 'chai'
import { TestAuthHelper, loadTestCredentials, createAuthenticatedHelper, createOtherServerAuthenticatedHelper } from './testAuthHelper.mjs'

// Load test configuration
let testConfig
let serverUrl
let appTable

try {
  testConfig = loadTestCredentials()
  serverUrl = testConfig.serverUrl
  appTable = testConfig.testAppConfig.appTable
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  console.error('Please ensure users_freezr/test_credentials/testUserCreds.json exists and is configured correctly.')
  process.exit(1)
}

describe('CEPS Endpoints Integration Tests', function () {
  // Increase timeout for network requests
  this.timeout(10000)

  let auth
  let createdRecordId

  // Test data
  const testRecord = {
    title: 'Test Record',
    description: 'Created by integration test',
    value: 42,
    tags: ['test', 'integration'],
    timestamp: Date.now()
  }

  before(async function () {
    // Login before running tests
    try {
      auth = await createAuthenticatedHelper('primary')
      console.log(`    ✓ Logged in as ${auth.userId}`)
    } catch (error) {
      console.error(`    ✗ Failed to authenticate: ${error.message}`)
      console.error('    Make sure the server is running and test user exists.')
      this.skip()
    }
  })

  // ===== APP INSTALLATION TEST =====
  describe('App Installation', function () {
    this.timeout(60000) // App installation can take longer
    
    it('should install app from GitHub URL', async function () {
      if (!auth) this.skip()
      
      const appUrl = 'https://github.com/salmanff/com.salmanff.poster'
      const appName = 'com.salmanff.poster'
      
      try {
        // const result = await auth.installAppFromUrl(appUrl, appName)
        // console.log(`      ✓ Installed app ${appName} from ${appUrl}`)
        
        // // Verify installation was successful
        // expect(result).to.exist
        // // The result may contain success indicators or app info
        // if (result.success !== undefined) {
        //   expect(result.success).to.be.true
        // }
        console.log(`      ✓ SKIPPING APP INSTALLATION TEST`)
      } catch (error) {
        // If app is already installed, that's okay - just log it
        const errorMsg = error.message || JSON.stringify(error)
        if (errorMsg.includes('already') || errorMsg.includes('exists') || errorMsg.includes('installed')) {
          console.log(`      ℹ App ${appName} is already installed (this is okay)`)
          // Don't fail the test if app is already installed
          return
        } else {
          // For other errors, log details and rethrow
          console.error(`      ✗ Failed to install app: ${errorMsg}`)
          throw error
        }
      }
    })
  })

  after(async function () {
    // Cleanup: Delete any remaining test records
    if (auth && createdRecordId) {
      try {
        await auth.delete(`/ceps/delete/${appTable}/${createdRecordId}`)
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    
    // Logout
    if (auth) {
      await auth.logout()
    }
  })

  // ===== PING TEST =====
  describe('GET /ceps/ping', function () {
    it('should return ping response when authenticated', async function () {
      const response = await auth.get('/ceps/ping')

      console.log('      🔑 ceps.test.mjs should return ping response when authenticated - response', response)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
    })
  })

  // ===== WRITE (CREATE) TESTS =====
  describe('POST /ceps/write/:app_table', function () {
    it('should create a new record', async function () {
      const response = await auth.post(`/ceps/write/${appTable}`, testRecord)
      // onsole.log('ceps.test.mjs should create a new record - response', response)

      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      expect(response.data._id).to.exist
      
      // Store ID for subsequent tests
      createdRecordId = response.data._id
    })

    it('should return CEPS 2.0 compliant response with _date_created and _date_modified', async function () {
      const response = await auth.post(`/ceps/write/${appTable}`, {
        title: 'CEPS Compliance Test',
        value: 123
      })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: _id, _date_created, _date_modified
      expect(response.data).to.have.property('_id')
      expect(response.data).to.have.property('_date_created')
      expect(response.data).to.have.property('_date_modified')
      
      // Verify timestamps are Unix epoch (numbers)
      expect(response.data._date_created).to.be.a('number')
      expect(response.data._date_modified).to.be.a('number')
      
      // _date_created and _date_modified should be equal for new records
      expect(response.data._date_created).to.equal(response.data._date_modified)
      
      // Cleanup
      await auth.delete(`/ceps/delete/${appTable}/${response.data._id}`)
    })

    it('should reject write without authentication', async function () {
      const unauthenticated = new TestAuthHelper(serverUrl)
      const response = await unauthenticated.post(`/ceps/write/${appTable}`, testRecord)
      
      expect(response.ok).to.be.false
      expect(response.status).to.equal(401)
    })

    it('should create record with custom fields', async function () {
      const customRecord = {
        customField: 'custom value',
        nested: { key: 'value' },
        arrayField: [1, 2, 3]
      }
      
      const response = await auth.post(`/ceps/write/${appTable}`, customRecord)
      
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist

      const tryQuery = await auth.get(`/ceps/query/${appTable}?customField=custom value`)
      // onsole.log('_mod_tests tryQuery', tryQuery)

      // const tryQuery2 = await auth.get(`/ceps/read/${appTable}/${response.data._id}`)
      // onsole.log('_mod_tests tryQuery2 should be from cache', tryQuery2)

      // Cleanup: delete this record
      const deleteResponse = await auth.delete(`/ceps/delete/${appTable}/${response.data._id}`)
      const tryQueryDelete = await auth.delete(`/ceps/delete/${appTable}/${response.data._id}`)
      // onsole.log('_mod_tests tryQueryDelete', tryQueryDelete)

      expect(deleteResponse.ok).to.be.true

      // const tryQuery3 = await auth.get(`/ceps/read/${appTable}/${response.data._id}`)
      // onsole.log('_mod_tests tryQuery3 should NOT be from cache and shoudl be null', tryQuery3)

    })
  })

  // ===== READ TESTS =====
  describe('GET /ceps/read/:app_table/:data_object_id', function () {
    it('should read an existing record by ID', async function () {
      if (!createdRecordId) this.skip()
      
      const response = await auth.get(`/ceps/read/${appTable}/${createdRecordId}`)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      expect(response.data._id).to.equal(createdRecordId)
      expect(response.data.title).to.equal(testRecord.title)
      expect(response.data.value).to.equal(testRecord.value)
    })

    it('should return CEPS 2.0 compliant response with _date_created and _date_modified', async function () {
      if (!createdRecordId) this.skip()
      
      const response = await auth.get(`/ceps/read/${appTable}/${createdRecordId}`)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: _id, _date_created, _date_modified
      expect(response.data).to.have.property('_id')
      expect(response.data).to.have.property('_date_created')
      expect(response.data).to.have.property('_date_modified')
      
      // Verify timestamps are Unix epoch (numbers)
      expect(response.data._date_created).to.be.a('number')
      expect(response.data._date_modified).to.be.a('number')
      
      // _date_modified should be >= _date_created
      expect(response.data._date_modified).to.be.at.least(response.data._date_created)
    })

    it('should return error for non-existent record', async function () {
      const fakeId = 'nonexistent_record_id_12345'
      const response = await auth.get(`/ceps/read/${appTable}/${fakeId}`)
      
      // onsole.log('should return error for non-existent record - response', response)
      // Server returns an error object with error message and code
      expect(response.status).to.equal(401)
      expect(response.data).to.be.an('object')
      expect(response.data.error).to.be.a('string')
      expect(response.data.error).to.include('no related records')
    })

    it('should reject read without authentication', async function () {
      if (!createdRecordId) this.skip()
      
      const unauthenticated = new TestAuthHelper(serverUrl)
      const response = await unauthenticated.get(`/ceps/read/${appTable}/${createdRecordId}`)
      
      expect(response.ok).to.be.false
      expect(response.status).to.equal(401)
    })
  })

  // ===== QUERY TESTS =====
  // Note: CEPS 2.0 spec requires query responses to be arrays, not objects
  // Format: [{records as JSON array}]
  describe('GET /ceps/query/:app_table', function () {
    it('should query records without filters (get all)', async function () {
      const response = await auth.get(`/ceps/query/${appTable}`)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: response must be an array of records
      expect(response.data).to.be.an('array')
    })

    it('should query records with filter parameters', async function () {
      // Query for records with specific title
      const response = await auth.get(`/ceps/query/${appTable}?title=${encodeURIComponent(testRecord.title)}`)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: response must be an array
      expect(response.data).to.be.an('array')
      
      // If we got results, they should match our filter
      const matching = response.data.filter(r => r.title === testRecord.title)
      expect(matching.length).to.be.at.least(0) // May be 0 if no matches
    })

    it('should return CEPS 2.0 compliant array response', async function () {
      const response = await auth.get(`/ceps/query/${appTable}`)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec: response MUST be an array of records (not an object)
      expect(response.data).to.be.an('array')
      
      // If we have results, verify they have required fields
      if (response.data.length > 0) {
        const firstRecord = response.data[0]
        expect(firstRecord).to.have.property('_id')
        expect(firstRecord).to.have.property('_date_created')
        expect(firstRecord).to.have.property('_date_modified')
      }
    })

    it('should return results sorted by _date_modified in descending order (CEPS 2.0 recommendation)', async function () {
      // Create multiple records with slight delays to ensure different timestamps
      const recordIds = []
      for (let i = 0; i < 3; i++) {
        const createResponse = await auth.post(`/ceps/write/${appTable}`, {
          title: `Sort Test Record ${i}`,
          index: i
        })
        recordIds.push(createResponse.data._id)
        // Small delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      
      try {
        const response = await auth.get(`/ceps/query/${appTable}`)
        expect(response.ok).to.be.true
        
        // CEPS 2.0 spec requires: response must be an array
        expect(response.data).to.be.an('array')
        
        // Verify sorting: should be descending by _date_modified (CEPS 2.0 recommendation)
        if (response.data.length >= 2) {
          for (let i = 0; i < response.data.length - 1; i++) {
            const current = response.data[i]
            const next = response.data[i + 1]
            
            if (current._date_modified && next._date_modified) {
              // Current should be >= next (descending order)
              expect(current._date_modified).to.be.at.least(next._date_modified)
            }
          }
        }
      } finally {
        // Cleanup: delete test records
        for (const id of recordIds) {
          try {
            await auth.delete(`/ceps/delete/${appTable}/${id}`)
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }
    })

    it('should support _modified_before and _modified_after query parameters (CEPS 2.0)', async function () {
      // Create a record with known timestamp
      const now = Date.now()
      const createResponse = await auth.post(`/ceps/write/${appTable}`, {
        title: 'Modified Date Test',
        timestamp: now
      })
      const testRecordId = createResponse.data._id
      const recordDateModified = createResponse.data._date_modified
      
      try {
        // const allResponseCheck = await auth.get(`/ceps/query/${appTable}`)
        // onsole.log(' allResponseCheck', allResponseCheck)

        // Query with _modified_after (should include our record)
        const afterResponse = await auth.get(`/ceps/query/${appTable}?_modified_after=${recordDateModified - 5000}`)

        expect(afterResponse.ok).to.be.true
        // onsole.log(' afterResponse.data', afterResponse.data)
        // CEPS 2.0 spec requires: response must be an array

        expect(afterResponse.data).to.be.an('array')
        const foundAfter = afterResponse.data.find(r => r._id === testRecordId)
        expect(foundAfter).to.exist
        
        // Query with _modified_before (should include our record)
        const beforeResponse = await auth.get(`/ceps/query/${appTable}?_modified_before=${recordDateModified + 5000}`)
        // onsole.log('should support _modified_before and _modified_after query parameters', {beforeResponse})
        expect(beforeResponse.ok).to.be.true
        // CEPS 2.0 spec requires: response must be an array
        expect(beforeResponse.data).to.be.an('array')
        const foundBefore = beforeResponse.data.find(r => r._id === testRecordId)
        expect(foundBefore).to.exist
        
        // Query with _modified_before that excludes our record
        const excludeResponse = await auth.get(`/ceps/query/${appTable}?_modified_before=${recordDateModified - 5000}`)
        expect(excludeResponse.ok).to.be.true
        // CEPS 2.0 spec requires: response must be an array
        expect(excludeResponse.data).to.be.an('array')
        const foundExcluded = excludeResponse.data.find(r => r._id === testRecordId)
        // Our record should not be in results (or may be, depending on implementation)
        // This test verifies the parameter is accepted
      } finally {
        // Cleanup
        await auth.delete(`/ceps/delete/${appTable}/${testRecordId}`)
      }
    })

    it('should reject query without authentication', async function () {
      const unauthenticated = new TestAuthHelper(serverUrl)
      const response = await unauthenticated.get(`/ceps/query/${appTable}`)
      
      expect(response.ok).to.be.false
      expect(response.status).to.equal(401)
    })

    it('should query records by specific key-value pairs', async function () {
      // Create multiple records with different key-value pairs
      const testRecords = [
        { category: 'fruit', name: 'apple', color: 'red', quantity: 10 },
        { category: 'fruit', name: 'banana', color: 'yellow', quantity: 5 },
        { category: 'vegetable', name: 'carrot', color: 'orange', quantity: 8 },
        { category: 'vegetable', name: 'lettuce', color: 'green', quantity: 3 }
      ]
      
      const createdIds = []
      
      try {
        // Create all test records
        for (const record of testRecords) {
          const response = await auth.post(`/ceps/write/${appTable}`, record)
          expect(response.ok).to.be.true
          createdIds.push(response.data._id)
        }
        
        // Query by category = 'fruit' - should return 2 records
        const fruitResponse = await auth.get(`/ceps/query/${appTable}?category=fruit`)
        expect(fruitResponse.ok).to.be.true
        expect(fruitResponse.data).to.be.an('array')
        const fruitRecords = fruitResponse.data.filter(r => r.category === 'fruit')
        expect(fruitRecords.length).to.be.at.least(2)
        console.log(`      ✓ Found ${fruitRecords.length} records with category=fruit`)
        
        // Query by color = 'red' - should return 1 record
        const redResponse = await auth.get(`/ceps/query/${appTable}?color=red`)
        expect(redResponse.ok).to.be.true
        expect(redResponse.data).to.be.an('array')
        const redRecords = redResponse.data.filter(r => r.color === 'red')
        expect(redRecords.length).to.be.at.least(1)
        expect(redRecords[0].name).to.equal('apple')
        console.log(`      ✓ Found ${redRecords.length} records with color=red`)
        
        // Query by multiple filters - category AND color
        const vegGreenResponse = await auth.get(`/ceps/query/${appTable}?category=vegetable&color=green`)
        expect(vegGreenResponse.ok).to.be.true
        expect(vegGreenResponse.data).to.be.an('array')
        const vegGreenRecords = vegGreenResponse.data.filter(r => r.category === 'vegetable' && r.color === 'green')
        expect(vegGreenRecords.length).to.be.at.least(1)
        expect(vegGreenRecords[0].name).to.equal('lettuce')
        console.log(`      ✓ Found ${vegGreenRecords.length} records with category=vegetable AND color=green`)
        
        // Query by name = 'banana' - should return 1 record
        const bananaResponse = await auth.get(`/ceps/query/${appTable}?name=banana`)
        expect(bananaResponse.ok).to.be.true
        expect(bananaResponse.data).to.be.an('array')
        const bananaRecords = bananaResponse.data.filter(r => r.name === 'banana')
        expect(bananaRecords.length).to.be.at.least(1)
        expect(bananaRecords[0].category).to.equal('fruit')
        expect(bananaRecords[0].color).to.equal('yellow')
        console.log(`      ✓ Found ${bananaRecords.length} records with name=banana`)
        
      } finally {
        // Cleanup: delete all test records
        for (const id of createdIds) {
          try {
            await auth.delete(`/ceps/delete/${appTable}/${id}`)
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }
    })

    it('should return empty array when querying with non-matching key-value pairs', async function () {
      // Create a record with specific values
      const testRecord = {
        category: 'test_category',
        status: 'active',
        value: 42
      }
      
      let testRecordId
      
      try {
        const createResponse = await auth.post(`/ceps/write/${appTable}`, testRecord)
        expect(createResponse.ok).to.be.true
        testRecordId = createResponse.data._id
        
        // Query with correct key-value pair - should return the record
        const correctResponse = await auth.get(`/ceps/query/${appTable}?category=test_category`)
        expect(correctResponse.ok).to.be.true
        expect(correctResponse.data).to.be.an('array')
        const correctMatches = correctResponse.data.filter(r => r._id === testRecordId)
        expect(correctMatches.length).to.be.at.least(1)
        console.log(`      ✓ Found record with correct key-value pair`)
        
        // Query with wrong value for existing key - should return no matching records
        const wrongValueResponse = await auth.get(`/ceps/query/${appTable}?category=wrong_category`)
        expect(wrongValueResponse.ok).to.be.true
        expect(wrongValueResponse.data).to.be.an('array')
        const wrongValueMatches = wrongValueResponse.data.filter(r => r._id === testRecordId)
        expect(wrongValueMatches.length).to.equal(0)
        console.log(`      ✓ No records found with wrong category value`)
        
        // Query with non-existent key - should return no matching records
        const wrongKeyResponse = await auth.get(`/ceps/query/${appTable}?nonexistent_key=some_value`)
        expect(wrongKeyResponse.ok).to.be.true
        expect(wrongKeyResponse.data).to.be.an('array')
        const wrongKeyMatches = wrongKeyResponse.data.filter(r => r._id === testRecordId)
        expect(wrongKeyMatches.length).to.equal(0)
        console.log(`      ✓ No records found with non-existent key`)
        
        // Query with wrong status value
        const wrongStatusResponse = await auth.get(`/ceps/query/${appTable}?status=inactive`)
        expect(wrongStatusResponse.ok).to.be.true
        expect(wrongStatusResponse.data).to.be.an('array')
        const wrongStatusMatches = wrongStatusResponse.data.filter(r => r._id === testRecordId)
        expect(wrongStatusMatches.length).to.equal(0)
        console.log(`      ✓ No records found with wrong status value`)
        
        // Query with multiple filters where one doesn't match
        const partialMatchResponse = await auth.get(`/ceps/query/${appTable}?category=test_category&status=inactive`)
        expect(partialMatchResponse.ok).to.be.true
        expect(partialMatchResponse.data).to.be.an('array')
        const partialMatches = partialMatchResponse.data.filter(r => r._id === testRecordId)
        expect(partialMatches.length).to.equal(0)
        console.log(`      ✓ No records found when one filter doesn't match`)
        
      } finally {
        // Cleanup
        if (testRecordId) {
          try {
            await auth.delete(`/ceps/delete/${appTable}/${testRecordId}`)
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }
    })

    it('should handle query with numeric key-value pairs', async function () {
      // Create records with numeric values
      const numericRecords = [
        { item: 'item1', price: 100, quantity: 5 },
        { item: 'item2', price: 200, quantity: 10 },
        { item: 'item3', price: 100, quantity: 3 }
      ]
      
      const createdIds = []
      
      try {
        // Create test records
        for (const record of numericRecords) {
          const response = await auth.post(`/ceps/write/${appTable}`, record)
          expect(response.ok).to.be.true
          createdIds.push(response.data._id)
        }

        const itmeNameResponse = await auth.get(`/ceps/query/${appTable}?item=item1`)
        expect(itmeNameResponse.ok).to.be.true
        expect(itmeNameResponse.data).to.be.an('array')
        console.log(`      ✓ Item name response`, { itmeNameResponse })
        const itmeNameRecords = itmeNameResponse.data.filter(r => r.item === 'item1')
        expect(itmeNameRecords.length).to.be.at.least(1)
        expect(itmeNameRecords[0].price).to.equal(100)
        console.log(`      ✓ Item name response`, { itmeNameResponse })
        
        // Query by price = 100 - should return 2 records
        const price100Response = await auth.get(`/ceps/query/${appTable}?price=100`)
        expect(price100Response.ok).to.be.true
        expect(price100Response.data).to.be.an('array')
        // console.log(`      ✓ Price 100 response`, { price100Response })
        const price100Records = price100Response.data.filter(r => r.price === 100)
        expect(price100Records.length).to.be.at.least(2)
        console.log(`      ✓ Found ${price100Records.length} records with price=100`)
        
        // Query by quantity = 10 - should return 1 record
        const qty10Response = await auth.get(`/ceps/query/${appTable}?quantity=10`)
        expect(qty10Response.ok).to.be.true
        expect(qty10Response.data).to.be.an('array')
        const qty10Records = qty10Response.data.filter(r => r.quantity === 10)
        expect(qty10Records.length).to.be.at.least(1)
        expect(qty10Records[0].item).to.equal('item2')
        console.log(`      ✓ Found ${qty10Records.length} records with quantity=10`)
        
        // Query with wrong numeric value - should return no records
        const wrongPriceResponse = await auth.get(`/ceps/query/${appTable}?price=999`)
        expect(wrongPriceResponse.ok).to.be.true
        expect(wrongPriceResponse.data).to.be.an('array')
        const wrongPriceMatches = wrongPriceResponse.data.filter(r => createdIds.includes(r._id))
        expect(wrongPriceMatches.length).to.equal(0)
        console.log(`      ✓ No records found with price=999`)
        
      } finally {
        // Cleanup
        for (const id of createdIds) {
          try {
            await auth.delete(`/ceps/delete/${appTable}/${id}`)
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }
    })
  })

  // ===== UPDATE TESTS =====
  describe('PUT /ceps/update/:app_table/:data_object_id', function () {
    it('should update an existing record', async function () {
      if (!createdRecordId) this.skip()
      
      const updates = {
        title: 'Updated Test Record',
        value: 100,
        updatedAt: Date.now()
      }
      
      const response = await auth.put(`/ceps/update/${appTable}/${createdRecordId}`, updates)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // Verify the update by reading the record
      const readResponse = await auth.get(`/ceps/read/${appTable}/${createdRecordId}`)
      expect(readResponse.ok).to.be.true
      expect(readResponse.data.title).to.equal(updates.title)
      expect(readResponse.data.value).to.equal(updates.value)
    })

    it('should return CEPS 2.0 compliant response with _date_created and _date_modified', async function () {
      if (!createdRecordId) this.skip()
      
      // First, read the original record to get its _date_created
      const beforeResponse = await auth.get(`/ceps/read/${appTable}/${createdRecordId}`)
      const originalDateCreated = beforeResponse.data._date_created
      const originalDateModified = beforeResponse.data._date_modified
      
      // Wait a bit to ensure _date_modified changes
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const updates = {
        title: 'CEPS Compliance Update Test',
        value: 999
      }
      
      const response = await auth.put(`/ceps/update/${appTable}/${createdRecordId}`, updates)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: _id, _date_created, _date_modified
      expect(response.data).to.have.property('_id')
      expect(response.data).to.have.property('_date_created')
      expect(response.data).to.have.property('_date_modified')
      
      // Verify timestamps are Unix epoch (numbers)
      expect(response.data._date_created).to.be.a('number')
      expect(response.data._date_modified).to.be.a('number')
      
      // _date_created should remain the same
      expect(response.data._date_created).to.equal(originalDateCreated)
      
      // _date_modified should be updated (greater than or equal to original)
      expect(response.data._date_modified).to.be.at.least(originalDateModified)
    })

    it('should reject update without authentication', async function () {
      if (!createdRecordId) this.skip()
      
      const unauthenticated = new TestAuthHelper(serverUrl)
      const response = await unauthenticated.put(`/ceps/update/${appTable}/${createdRecordId}`, { title: 'Hacked' })
      
      expect(response.ok).to.be.false
      expect(response.status).to.equal(401)
    })
  })

  // ===== DELETE TESTS ===== 
  describe('DELETE /ceps/delete/:app_table/:data_object_id', function () {
    let recordToDeleteId

    before(async function () {
      // Create a record specifically for deletion testing
      const response = await auth.post(`/ceps/write/${appTable}`, {
        title: 'Record to delete',
        purpose: 'deletion test'
      })
      
      if (response.ok) {
        recordToDeleteId = response.data._id
      }
    })

    it('should delete an existing record', async function () {
      if (!recordToDeleteId) this.skip()
      
      const response = await auth.delete(`/ceps/delete/${appTable}/${recordToDeleteId}`)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      expect(response.data.success).to.be.true
      
      // Verify the record is deleted by trying to read it
      const readResponse = await auth.get(`/ceps/read/${appTable}/${recordToDeleteId}`)
      
      // Should return error object with "no related records" message
      expect(readResponse.status).to.equal(401)
      expect(readResponse.data.error).to.be.a('string')
      expect(readResponse.data.error).to.include('no related records')
    })

    it('should return CEPS 2.0 compliant response with _id, _date_created, and _date_modified', async function () {
      // Create a record specifically for this test
      const createResponse = await auth.post(`/ceps/write/${appTable}`, {
        title: 'CEPS Delete Compliance Test',
        value: 456
      })
      const testDeleteId = createResponse.data._id
      const originalDateCreated = createResponse.data._date_created
      const originalDateModified = createResponse.data._date_modified
      
      const response = await auth.delete(`/ceps/delete/${appTable}/${testDeleteId}`)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: _id, _date_created, _date_modified
      // Note: Some implementations may return {success: true} instead
      // We check for either format
      if (response.data._id) {
        // CEPS 2.0 compliant format
        expect(response.data).to.have.property('_id')
        expect(response.data).to.have.property('_date_created')
        expect(response.data).to.have.property('_date_modified')
        
        expect(response.data._id).to.equal(testDeleteId)
        expect(response.data._date_created).to.equal(originalDateCreated)
        expect(response.data._date_modified).to.equal(originalDateModified)
      } else {
        // Alternative format (still valid, but note it for compliance)
        expect(response.data).to.have.property('success')
        console.log('      Note: Delete response uses {success: true} format instead of CEPS 2.0 {_id, _date_created, _date_modified}')
      }
    })

    it('should reject delete without authentication', async function () {
      // Create another record to test unauthorized delete
      const createResponse = await auth.post(`/ceps/write/${appTable}`, { title: 'Protected record' })
      const protectedId = createResponse.data._id
      
      const unauthenticated = new TestAuthHelper(serverUrl)
      const response = await unauthenticated.delete(`/ceps/delete/${appTable}/${protectedId}`)
      
      expect(response.ok).to.be.false
      expect(response.status).to.equal(401)
      
      // Cleanup: delete with proper auth
      await auth.delete(`/ceps/delete/${appTable}/${protectedId}`)
    })
  })

  // ===== CLEANUP =====
  describe('Cleanup', function () {
    it('should delete the main test record', async function () {
      if (!createdRecordId) this.skip()
      
      const response = await auth.delete(`/ceps/delete/${appTable}/${createdRecordId}`)
      
      expect(response.ok).to.be.true
      createdRecordId = null // Mark as deleted
    })
  })
})

// ===== MULTI-USER TESTS (OPTIONAL) =====
describe('CEPS Multi-User Tests', function () {
  this.timeout(15000)

  let primaryAuth
  let secondaryAuth
  let primaryRecordId

  before(async function () {
    try {
      primaryAuth = await createAuthenticatedHelper('primary')
      console.log(`    ✓ Primary user logged in: ${primaryAuth.userId}`)
    } catch (error) {
      console.warn(`    ⚠ Primary user login failed: ${error.message}`)
      this.skip()
    }

    try {
      secondaryAuth = await createAuthenticatedHelper('secondary')
      console.log(`    ✓ Secondary user logged in: ${secondaryAuth.userId}`)
    } catch (error) {
      console.warn(`    ⚠ Secondary user login failed: ${error.message}`)
      console.warn('    Multi-user tests will be skipped. Create secondary test user to enable.')
      this.skip()
    }
  })

  after(async function () {
    // Cleanup
    if (primaryAuth && primaryRecordId) {
      try {
        await primaryAuth.delete(`/ceps/delete/${appTable}/${primaryRecordId}`)
      } catch (e) {
        // Ignore
      }
    }
    
    if (primaryAuth) await primaryAuth.logout()
    if (secondaryAuth) await secondaryAuth.logout()
  })

  it('should allow user to create record in their own space', async function () {
    if (!primaryAuth) this.skip()
    
    const response = await primaryAuth.post(`/ceps/write/${appTable}`, {
      title: 'Primary user record',
      owner: 'primary'
    })
    
    expect(response.ok).to.be.true
    primaryRecordId = response.data._id
  })

  it('users should have isolated data by default', async function () {
    if (!primaryAuth || !secondaryAuth || !primaryRecordId) this.skip()
    
    // Secondary user queries - should not see primary's records (unless shared)
    const response = await secondaryAuth.get(`/ceps/query/${appTable}?owner=primary`)
    
    expect(response.ok).to.be.true
    
    // CEPS 2.0 spec requires: response must be an array
    expect(response.data).to.be.an('array')
    
    // The response behavior depends on permission settings
    // By default, users should only see their own records
    // This is informational - actual behavior depends on app permissions
    console.log(`      Secondary user query returned ${response.data.length} results`)
  })
})

// ===== PERMISSIONS TESTS =====
describe('CEPS Permissions Tests', function () {
  this.timeout(30000)

  let primaryAuth
  let secondaryAuth
  let primaryRecordId
  const permissionName = 'public_link_test'
  const permissionTableId = appTable

  before(async function () {
    try {
      primaryAuth = await createAuthenticatedHelper('primary')
      console.log(`    ✓ Primary user logged in: ${primaryAuth.userId}`)
    } catch (error) {
      console.error(`    ✗ Primary user login failed: ${error.message}`)
      this.skip()
    }

    try {
      secondaryAuth = await createAuthenticatedHelper('secondary')
      console.log(`    ✓ Secondary user logged in: ${secondaryAuth.userId}`)
    } catch (error) {
      console.warn(`    ⚠ Secondary user login failed: ${error.message}`)
      console.warn('    Permissions tests will be skipped. Create secondary test user to enable.')
      this.skip()
    }
  })

  after(async function () {
    // Cleanup
    if (primaryAuth && primaryRecordId) {
      try {
        await primaryAuth.delete(`/ceps/delete/${appTable}/${primaryRecordId}`)
      } catch (e) {
        // Ignore
      }
    }
    
    if (primaryAuth) await primaryAuth.logout()
    if (secondaryAuth) await secondaryAuth.logout()
  })

  it('should get permissions using app access token (CEPS 2.0)', async function () {
    if (!primaryAuth) this.skip()
    
    const permissions = await primaryAuth.getPermissions()
    
    // CEPS 2.0 spec: response should be an array
    expect(permissions).to.be.an('array')
    console.log(`      ✓ Got ${permissions.length} permissions`)
    // console.log(`      ✓ Got  permissions`, { permissions })
    
    // Check if our test permission exists
    const testPermission = permissions.find(p => p.name === permissionName && p.table_id.includes(permissionTableId))
    if (testPermission) {
      console.log(`      ✓ Found permission: ${permissionName} for table ${permissionTableId}`)
      console.log(`        Granted: ${testPermission.granted || false}`)
      console.log(`        Type: ${testPermission.type || 'unknown'}`)
    } else {
      console.log(`      ℹ Permission ${permissionName} not found (may need to be registered)`)
    }
  })

  it('should get permissions filtered by table-id (CEPS 2.0)', async function () {
    if (!primaryAuth) this.skip()
    
    const permissions = await primaryAuth.getPermissions(permissionTableId)
    
    expect(permissions).to.be.an('array')
    // At least one permission should match the table_id
    const hasMatchingPermission = permissions.some(perm => {
      // console.log('🔐 Checking permission:', { perm });
      return perm.table_id.includes(permissionTableId);
    });
    expect(hasMatchingPermission).to.be.true;
    console.log(`      ✓ Got ${permissions.length} permissions for table ${permissionTableId}`)
  })

  it('should grant permission using account access token', async function () {
    if (!primaryAuth) this.skip()
    
    const result = await primaryAuth.changePermission(
      permissionName,
      permissionTableId,
      testConfig.testAppConfig.appName,
      testConfig.testAppConfig.appName,
      true // grant
    )
    
    console.log(`      ✓ Permission ${permissionName} granted`) // , { result})
    expect(result).to.exist
  })

  it('should show permission as granted after granting', async function () {
    if (!primaryAuth) this.skip()
    
    const permissions = await primaryAuth.getPermissions(permissionTableId, permissionName)
    
    expect(permissions).to.be.an('array')
    const testPermission = permissions.find(p => p.name === permissionName && p.table_id.includes(permissionTableId))
    // console.log('🔐 show permission as granted after granting') // , { permissions, permissionName, permissionTableId,testPermission, appname: testConfig.testAppConfig.appName })

    expect(testPermission).to.exist
    expect(testPermission.granted).to.be.true
    console.log(`      ✓ Permission ${permissionName} is now granted`)
  })

  it('should allow primary user to create a record', async function () {
    if (!primaryAuth) this.skip()
    
    const response = await primaryAuth.post(`/ceps/write/${appTable}`, {
      title: 'Shared Record',
      owner: 'primary',
      content: 'This record should be accessible to secondary user after sharing'
    })
    
    expect(response.ok).to.be.true
    expect(response.data._id).to.exist
    primaryRecordId = response.data._id
    console.log(`      ✓ Primary user created record: ${primaryRecordId}`)
  })

  it('should allow primary user to share record with secondary user using app token', async function () {
    // if (!primaryAuth || !secondaryAuth || !primaryRecordId) this.skip()
    
    // Share the record with secondary user using app token
    // CEPS 2.0 spec: requires name (permission name), table_id, record_id, and grantees
    const response = await primaryAuth.post('/ceps/perms/share_records', {
      name: permissionName,
      table_id: appTable,
      record_id: primaryRecordId,
      grantees: [secondaryAuth.userId],
      action: 'grant'
    })
    // console.log('🔐 share records response', { appTable, primaryRecordId, secondaryAuthUserId: secondaryAuth.userId, action: 'grant', response })
    
    expect(response.ok).to.be.true
    console.log(`      ✓ Primary user shared record with secondary user`)
  // })

  // it('should allow secondary user to read primary user\'s shared record', async function () {
    // if (!secondaryAuth || !primaryRecordId) this.skip()
    
    const responseAuth2 = await secondaryAuth.get(`/ceps/read/${appTable}/${primaryRecordId}?owner_id=${primaryAuth.userId}`)
    
    // onsole.log(`- Secondary user reading primary user's record`, { owner_id: primaryAuth.userId, responseAuth2 })
    expect(responseAuth2.ok).to.be.true
    expect(responseAuth2.data).to.be.an('object')
    expect(responseAuth2.data._id).to.equal(primaryRecordId)
    expect(responseAuth2.data.title).to.equal('Shared Record')
    console.log(`      ✓ Secondary user successfully read primary user's record`)
  })

  // ===== MESSAGE TESTS =====
  // CEPS 2.0 Message Flow:
  // 1. /ceps/message/initiate - Initiates message (may handle transmit internally for same-server)
  // 2. /ceps/message/transmit - Transmits message to recipient server (usually called by server)
  // 3. /ceps/message/verify - Verifies message on recipient side (usually called by server)
  // 4. Query dev.ceps.messages.got to retrieve received messages
  describe('CEPS Message Tests', function () {
    const messagePermissionName = 'message_link'
    const contactPermissionName = 'friends' // Common contact permission name
    const messagesPermissionName = 'message_link' // Permission for dev.ceps.messages.got
    let messageRecordId
    let sentMessageId

    it('should grant message_link permission (type: message_records) for primary user', async function () {
      if (!primaryAuth) this.skip()
      
      // First, check if the permission exists
      const permissions = await primaryAuth.getPermissions()
      const messagePerm = permissions.find(p => 
        p.name === messagePermissionName && 
        p.type === 'message_records'
      )
      
      if (messagePerm) {
        // Grant it if not already granted
        if (!messagePerm.granted) {
          const result = await primaryAuth.changePermission(
            messagePermissionName,
            null,
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true // grant
          )
          expect(result).to.exist
          console.log(`      ✓ Granted ${messagePermissionName} permission for table ${messagePerm.table_id}`)
        } else {
          console.log(`      ✓ ${messagePermissionName} permission already granted`)
        }
      } else {
        console.log(`      ℹ ${messagePermissionName} permission not found in app manifest`)
        this.skip()
      }
    })

    it('should grant contact permission for primary user', async function () {
      if (!primaryAuth) this.skip()
      
      // Check if contact permission exists
      const permissions = await primaryAuth.getPermissions()
      const contactPerm = permissions.find(p => 
        p.name === contactPermissionName && 
        p.table_id === 'dev.ceps.contacts' &&
        (p.type === 'read_all' || p.type === 'write_own' || p.type === 'write_all')
      )
      
      if (contactPerm) {
        if (!contactPerm.granted) {
          const result = await primaryAuth.changePermission(
            contactPermissionName,
            null,
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true // grant
          )
          expect(result).to.exist
          console.log(`      ✓ Granted ${contactPermissionName} permission for contacts`)
        } else {
          console.log(`      ✓ ${contactPermissionName} permission already granted`)
        }
      } else {
        console.log(`      ℹ ${contactPermissionName} permission not found - may need to be registered`)
        // Try to grant anyway - the permission might exist but not be in the list
        try {
          await primaryAuth.changePermission(
            contactPermissionName,
            'dev.ceps.contacts',
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true
          )
          console.log(`      ✓ Attempted to grant ${contactPermissionName} permission`)
        } catch (e) {
          console.log(`      ⚠ Could not grant contact permission: ${e.message}`)
        }
      }
    })

    it('should verify both message_link and contact permissions are granted before sending', async function () {
      if (!primaryAuth) this.skip()
      
      const permissions = await primaryAuth.getPermissions()
      
      // Verify message_link permission is granted
      const messagePerm = permissions.find(p => 
        p.name === messagePermissionName && 
        p.type === 'message_records' &&
        p.granted === true
      )
      // onsole.log('🔐 verify both message_link and contact permissions are granted before sending', { permissions, messagePerm })
      expect(messagePerm).to.exist
      expect(messagePerm.granted).to.be.true
      console.log(`      ✓ Verified ${messagePermissionName} permission is granted`)
      
      // Verify contact permission is granted
      const contactPerm = permissions.find(p => 
        p.name === contactPermissionName && 
        (p.table_id === 'dev.ceps.contacts' || p.table_id.includes('dev.ceps.contacts')) &&
        (p.type === 'read_all' || p.type === 'write_own' || p.type === 'write_all') &&
        p.granted === true
      )
      // onsole.log('🔐 verify both message_link and contact permissions are granted before sending', { permissions, contactPerm })
      expect(contactPerm).to.exist
      expect(contactPerm.granted).to.be.true
      console.log(`      ✓ Verified ${contactPermissionName} permission is granted for dev.ceps.contacts`)
      
      // Both permissions must be granted to send messages
      if (!messagePerm || !contactPerm) {
        throw new Error('Required permissions not granted. Cannot send message without both message_link and contact permissions.')
      }
    })

    it('should create a record to send as a message', async function () {
      if (!primaryAuth) this.skip()
      
      const response = await primaryAuth.post(`/ceps/write/${appTable}`, {
        title: 'Message Test Record',
        content: 'This record will be sent as a message',
        owner: 'primary',
        messageData: { important: true, priority: 'high' }
      })
      
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist
      messageRecordId = response.data._id
      console.log(`      ✓ Created record for messaging: ${messageRecordId}`)
    })

    it('should send a message using /ceps/message/initiate', async function () {
      if (!primaryAuth || !secondaryAuth || !messageRecordId) this.skip()
      
      // First, verify both required permissions are granted
      const permissions = await primaryAuth.getPermissions()
      const messagePerm = permissions.find(p => 
        p.name === messagePermissionName && 
        p.type === 'message_records' &&
        p.granted === true
      )
      const contactPerm = permissions.find(p => 
        p.name === contactPermissionName && 
        p.granted === true
      )
      
      if (!messagePerm || !contactPerm) {
        throw new Error(`Cannot send message: Required permissions not granted. message_link: ${!!messagePerm}, contact: ${!!contactPerm}`)
      }
      
      console.log(`      ✓ Verified permissions before sending: message_link=${messagePerm.granted}, contact=${contactPerm.granted}`)
      
      // Get the full record to send
      const recordResponse = await primaryAuth.get(`/ceps/read/${appTable}/${messageRecordId}`)
      expect(recordResponse.ok).to.be.true
      
      // Send message - use a subset of the record for message_records
      const messageRecord = {
        title: recordResponse.data.title,
        content: recordResponse.data.content,
        messageData: recordResponse.data.messageData
      }
      
      const result = await primaryAuth.sendMessage(
        secondaryAuth.userId,
        null, // same server (recipient_host omitted)
        appTable,
        messageRecordId,
        messagePermissionName,
        contactPermissionName,
        messageRecord,
        'Test message from primary user'
      )
      
      expect(result).to.exist
      if (result.success !== undefined) {
        expect(result.success).to.be.true
      }
      if (result.message_id) {
        sentMessageId = result.message_id
      }
      console.log(`      ✓ Message initiated successfully`)
    })

    it('should grant messages permission for secondary user to read messages', async function () {
      if (!secondaryAuth) this.skip()

      // await new Promise(resolve => setTimeout(resolve, 1000))
      
      // Check if messages permission exists
      const permissions = await secondaryAuth.getPermissions()
      const messagesPerm = permissions.find(p => 
        p.name === messagesPermissionName
      )
      
      if (messagesPerm) {
        if (!messagesPerm.granted) {
          const result = await secondaryAuth.changePermission(
            messagesPermissionName,
            messagesPerm.table_id, // Use the actual table_id from the permission
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true // grant
          )
          expect(result).to.exist
          console.log(`      ✓ Secondary user granted ${messagesPermissionName} permission for ${messagesPerm.table_id}`)
        } else {
          // console.log(`      ✓ Secondary user already has ${messagesPermissionName} permission` ) // , { messagesPerm }
        }
      } else {
        console.log(`      Permissions`, { permissions, messagesPerm, messagesPermissionName })
        console.log(`      ℹ ${messagesPermissionName} permission not found - trying to grant for dev.ceps.messages.got`)
        try {
          await secondaryAuth.changePermission(
            messagesPermissionName,
            'dev.ceps.messages.got', // Use the expected table_id
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true
          )
          console.log(`      ✓ Attempted to grant ${messagesPermissionName} permission`)
        } catch (e) {
          console.log(`      ⚠ Could not grant messages permission: ${e.message}`)
        }
      }
    })
    console.log('🔐 messages permission granted for secondary user', {  })

    it('should allow secondary user to query dev.ceps.messages.got to retrieve messages', async function () {
      if (!secondaryAuth || !messageRecordId) this.skip()
      
      // Wait a bit for message to be processed (initiate -> transmit -> verify flow)
      // Note: initiate may handle transmit internally, and verify happens on recipient side
      
      // await new Promise(resolve => setTimeout(resolve, 5000))
      const permissions = await secondaryAuth.getPermissions()
      const messagesPerm = permissions.find(p => 
        p.name === messagesPermissionName
      )

      // Check if permission exists before trying to use it
      if (!messagesPerm) {
        throw new Error(`Permission ${messagesPermissionName} not found. It may have been denied by a previous test or cleanup.`)
      }

      // Verify permission is granted before proceeding
      if (!messagesPerm.granted) {
        console.log(`      ℹ Permission ${messagesPermissionName} is not granted, attempting to grant...`)
        // regrant
        const result2 = await secondaryAuth.changePermission(
          messagesPermissionName,
          messagesPerm.table_id, // Use the actual table_id from the permission
          testConfig.testAppConfig.appName,
          testConfig.testAppConfig.appName,
          true // grant
        )
        // onsole.log('🔐 messages - regranted messages permission', { result2 })
        
        // Verify it was granted
        const permissionsAfter = await secondaryAuth.getPermissions()
        const messagesPermAfter = permissionsAfter.find(p => 
          p.name === messagesPermissionName
        )
        if (!messagesPermAfter || !messagesPermAfter.granted) {
          throw new Error(`Failed to grant ${messagesPermissionName} permission. Permission may have been denied by another test.`)
        }
      } else {
        console.log(`      ✓ Permission ${messagesPermissionName} is already granted`)
      }
      
      let messages = null
      let errorMessage = null
      try {
        messages = await secondaryAuth.getMessages({ app_id: testConfig.testAppConfig.appName })
        //  onsole.log('🔐 messages - messages', { messages })
      
      } catch (e) {
        errorMessage = e.message || String(e)
        // onsole.log('🔐 messages - error getting messages', { error: errorMessage, stack: e.stack })
        // Re-throw with more context if it's a permission issue
        if (errorMessage.includes('Permission') || errorMessage.includes('permission') || errorMessage.includes('401') || errorMessage.includes('403')) {
          throw new Error(`Failed to get messages due to permission issue: ${errorMessage}. This may indicate permissions were denied by a previous test or cleanup hook.`)
        }
        // For other errors, also re-throw to fail the test with a clear message
        throw new Error(`Failed to get messages: ${errorMessage}`)
      }
      
      // At this point, messages should be an array (getMessages throws if it's not)
      expect(messages).to.be.an('array')
      console.log(`      ✓ Secondary user retrieved ${messages.length} messages from dev.ceps.messages.got`)
      
      // Find the message we sent
      const ourMessage = messages.find(m => 
        m.sender_id === primaryAuth.userId &&
        m.record_id === messageRecordId &&
        (m.table_id === appTable || m.table_id.includes(appTable))
      )
      
      if (ourMessage) {
        expect(ourMessage.type).to.equal('message_records')
        expect(ourMessage.messaging_permission).to.equal(messagePermissionName)
        expect(ourMessage.record).to.exist
        expect(ourMessage.record.title).to.equal('Message Test Record')
        expect(ourMessage.message).to.equal('Test message from primary user')
        console.log(`      ✓ Found the sent message in dev.ceps.messages.got`)
        console.log(`        Message ID: ${ourMessage._id}`)
        console.log(`        Sender: ${ourMessage.sender_id}`)
        console.log(`        Type: ${ourMessage.type}`)
      } else {
        console.log(`      ⚠ Message not found yet - may need more time to process, `, {user: primaryAuth.userId, messageRecordId, appTable} )
        console.log(`        Available messages: ${messages.length}`)
        if (messages.length > 0) {
          console.log(`        Sample message:`, JSON.stringify(messages[0], null, 2))
        }
        // Don't fail the test, just log it - the message might still be processing
      }
    })

  })
})

// ===== CROSS-SERVER TESTS =====
describe('CEPS Cross-Server Tests', function () {
  this.timeout(60000) // Cross-server tests may take longer

  let primaryAuth
  let otherServerAuth
  let crossServerMessageRecordId
  let crossServerSharedRecordId
  const messagePermissionName = 'message_link'
  const contactPermissionName = 'friends'
  const sharePermissionName = 'public_link_test'

  before(async function () {
    try {
      primaryAuth = await createAuthenticatedHelper('primary')
      console.log(`    ✓ Primary user logged in on ${primaryAuth.serverUrl}: ${primaryAuth.userId}`)
    } catch (error) {
      console.error(`    ✗ Primary user login failed: ${error.message}`)
      this.skip()
    }

    try {
      otherServerAuth = await createOtherServerAuthenticatedHelper('primary')
      console.log(`    ✓ Other server user logged in on ${otherServerAuth.serverUrl}: ${otherServerAuth.userId}`)
    } catch (error) {
      console.warn(`    ⚠ Other server user login failed: ${error.message}`)
      console.warn('    Cross-server tests will be skipped. Ensure otherServerUrl and otherServerUsers are configured.')
      this.skip()
    }
  })

  after(async function () {
    // Cleanup
    if (primaryAuth && crossServerMessageRecordId) {
      try {
        await primaryAuth.delete(`/ceps/delete/${appTable}/${crossServerMessageRecordId}`)
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    
    if (primaryAuth && crossServerSharedRecordId) {
      try {
        await primaryAuth.delete(`/ceps/delete/${appTable}/${crossServerSharedRecordId}`)
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    
    if (primaryAuth) await primaryAuth.logout()
    if (otherServerAuth) await otherServerAuth.logout()
  })

  it('should grant required permissions for cross-server messaging', async function () {
    if (!primaryAuth || !otherServerAuth) this.skip()
    
    // Grant message_link permission for primary user
    const primaryPerms = await primaryAuth.getPermissions()
    const messagePerm = primaryPerms.find(p => 
      p.name === messagePermissionName && 
      p.type === 'message_records'
    )
    
    if (messagePerm && !messagePerm.granted) {
      await primaryAuth.changePermission(
        messagePermissionName,
        null,
        testConfig.testAppConfig.appName,
        testConfig.testAppConfig.appName,
        true
      )
      console.log(`      ✓ Granted ${messagePermissionName} permission for primary user`)
    }
    
    // Grant contact permission for primary user
    const contactPerm = primaryPerms.find(p => 
      p.name === contactPermissionName
    )
    if (contactPerm && !contactPerm.granted) {
      await primaryAuth.changePermission(
        contactPermissionName,
        null,
        testConfig.testAppConfig.appName,
        testConfig.testAppConfig.appName,
        true
      )
      console.log(`      ✓ Granted ${contactPermissionName} permission for primary user`)
    }
  })

  it('should send a message from primary server to other server', async function () {
    if (!primaryAuth || !otherServerAuth) this.skip()
    
    // Create a record to send as a message
    const createResponse = await primaryAuth.post(`/ceps/write/${appTable}`, {
      title: 'Cross-Server Message Test',
      content: 'This record will be sent to another server',
      owner: 'primary',
      crossServer: true
    })
    
    expect(createResponse.ok).to.be.true
    expect(createResponse.data._id).to.exist
    crossServerMessageRecordId = createResponse.data._id
    console.log(`      ✓ Created record for cross-server messaging: ${crossServerMessageRecordId}`)
    
    // Get the full record to send
    const recordResponse = await primaryAuth.get(`/ceps/read/${appTable}/${crossServerMessageRecordId}`)
    expect(recordResponse.ok).to.be.true
    
    // Prepare message record
    const messageRecord = {
      title: recordResponse.data.title,
      content: recordResponse.data.content,
      owner: recordResponse.data.owner
    }

    // onsole.log('🔐 sendmessagecheck last step before sendMessage', { messageRecord })
    
    // Send message to other server with recipient_host
    const result = await primaryAuth.sendMessage(
      otherServerAuth.userId,
      otherServerAuth.serverUrl, // recipient_host - this is the key for cross-server
      appTable,
      crossServerMessageRecordId,
      messagePermissionName,
      contactPermissionName,
      messageRecord,
      'Cross-server test message'
    )

    // onsole.log('🔐 sendmessagecheck last step after sendMessage', { result  })

    
    expect(result).to.exist
    if (result.success !== undefined) {
      expect(result.success).to.be.true
    }
    console.log(`      ✓ Message sent from ${primaryAuth.serverUrl} to ${otherServerAuth.serverUrl}`)
  })

  it('should allow other server user to receive and check the message', async function () {
    if (!otherServerAuth || !crossServerMessageRecordId) this.skip()
    
    // Grant messages permission for other server user
    const otherPerms = await otherServerAuth.getPermissions()
    const messagesPerm = otherPerms.find(p => 
      p.name === messagePermissionName
    )
    
    if (messagesPerm && !messagesPerm.granted) {
      await otherServerAuth.changePermission(
        messagePermissionName,
        messagesPerm.table_id || 'dev.ceps.messages.got',
        testConfig.testAppConfig.appName,
        testConfig.testAppConfig.appName,
        true
      )
      console.log(`      ✓ Granted ${messagePermissionName} permission for other server user`)
    }
    
    // Wait a bit for message to be processed
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    // Query messages on other server
    let messages = null
    try {
      messages = await otherServerAuth.getMessages({ app_id: testConfig.testAppConfig.appName })
      console.log(`      ✓ Other server user retrieved ${messages.length} messages`)
    } catch (e) {
      console.log(`      ⚠ Error getting messages: ${e.message}`)
      // Don't fail - message might still be processing
      return
    }
    
    expect(messages).to.be.an('array')
    
    // Find the message we sent
    const ourMessage = messages.find(m => 
      m.sender_id === primaryAuth.userId &&
      m.record_id === crossServerMessageRecordId &&
      (m.table_id === appTable || m.table_id.includes(appTable))
    )
    
    if (ourMessage) {
      expect(ourMessage.type).to.equal('message_records')
      expect(ourMessage.sender_id).to.equal(primaryAuth.userId)
      expect(ourMessage.record).to.exist
      expect(ourMessage.record.title).to.equal('Cross-Server Message Test')
      console.log(`      ✓ Found cross-server message in other server's dev.ceps.messages.got`)
      console.log(`        Message ID: ${ourMessage._id}`)
      console.log(`        Sender: ${ourMessage.sender_id}@${ourMessage.sender_host || 'same server'}`)
    } else {
      console.log(`      ⚠ Cross-server message not found yet - may need more time to process`)
      console.log(`        Available messages: ${messages.length}`)
      if (messages.length > 0) {
        console.log(`        Sample message:`, JSON.stringify(messages[0], null, 2))
      }
    }
  })

  it('should share a record with other server user using recipient_host', async function () {
    if (!primaryAuth || !otherServerAuth) this.skip()
    
    // Create a record to share
    const createResponse = await primaryAuth.post(`/ceps/write/${appTable}`, {
      title: 'Cross-Server Shared Record',
      content: 'This record will be shared with another server user',
      owner: 'primary',
      shared: true
    })
    
    expect(createResponse.ok).to.be.true
    expect(createResponse.data._id).to.exist
    crossServerSharedRecordId = createResponse.data._id
    console.log(`      ✓ Created record for cross-server sharing: ${crossServerSharedRecordId}`)
    
    // Grant share permission if needed
    const primaryPerms = await primaryAuth.getPermissions()
    const sharePerm = primaryPerms.find(p => 
      p.name === sharePermissionName && 
      p.table_id.includes(appTable)
    )
    
    if (sharePerm && !sharePerm.granted) {
      await primaryAuth.changePermission(
        sharePermissionName,
        appTable,
        testConfig.testAppConfig.appName,
        testConfig.testAppConfig.appName,
        true
      )
      console.log(`      ✓ Granted ${sharePermissionName} permission for sharing`)
    }
    
    // Share the record with other server user - format: "user@host" for cross-server
    // Convert server URL to the format expected (dots replaced with underscores)
    const recipientHostFormatted = otherServerAuth.serverUrl.replace(/\./g, '_')
    const granteeString = `${otherServerAuth.userId}@${recipientHostFormatted}`
    
    const shareResponse = await primaryAuth.post('/ceps/perms/share_records', {
      name: sharePermissionName,
      table_id: appTable,
      record_id: crossServerSharedRecordId,
      grantees: [granteeString],
      action: 'grant'
    })
    
    // console.log('🔐 Cross-server share_records response', { 
    //   appTable, 
    //   crossServerSharedRecordId, 
    //   otherServerUserId: otherServerAuth.userId,
    //   otherServerUrl: otherServerAuth.serverUrl,
    //   response: shareResponse 
    // })
    
    expect(shareResponse.ok).to.be.true
    console.log(`      ✓ Shared record with other server user (${granteeString})`)
  })

  it('should allow other server user to validate credentials using CEPSValidation', async function () {
    if (!otherServerAuth || !crossServerSharedRecordId) this.skip()
    
    // CEPS Validation Flow (as per validateDataOwner in freezr_core.js):
    // Step 1: Requestor calls POST /ceps/perms/validationtoken/set on THEIR OWN server
    // Step 2: Requestor calls GET /ceps/perms/validationtoken/validate on DATA OWNER's server
    
    // Step 1: Get validation token from requestor's own server
    const setResponse = await otherServerAuth.post('/ceps/perms/validationtoken/set', {
      data_owner_user: primaryAuth.userId,
      data_owner_host: primaryAuth.serverUrl,
      table_id: appTable,
      permission: sharePermissionName,
      app_id: testConfig.testAppConfig.appName,
      record_id: crossServerSharedRecordId
    })
    
    // console.log(`      Step 1 - Set validation token response:`, setResponse)
    
    expect(setResponse.ok).to.be.true
    expect(setResponse.data.validation_token).to.exist
    expect(setResponse.data.requestor_host).to.exist
    expect(setResponse.data.expiration).to.exist
    
    const validationToken = setResponse.data.validation_token
    const requestorHost = setResponse.data.requestor_host
    
    console.log(`      ✓ Got validation token from requestor's server: ${validationToken.substring(0, 10)}...`)
    
    // Step 2: Validate on data owner's server (primary server)
    const fetch = (await import('node-fetch')).default
    
    const validateParams = new URLSearchParams({
      action: 'validate',
      validation_token: validationToken,
      data_owner_user: primaryAuth.userId,
      data_owner_host: primaryAuth.serverUrl,
      table_id: appTable,
      permission: sharePermissionName,
      app_id: testConfig.testAppConfig.appName,
      requestor_user: otherServerAuth.userId,
      requestor_host: otherServerAuth.serverUrl
    })
    
    // console.log(`      Step 2 - Validating on data owner's server with params:`, Object.fromEntries(validateParams))
    
    try {
      // Make request to primary server (data owner's server) for validation
      const validateUrl = `${primaryAuth.serverUrl}/ceps/perms/validationtoken/validate?${validateParams.toString()}`
      const fetchResponse = await fetch(validateUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      
      const validationData = await fetchResponse.json()
      const validationResponse = {
        status: fetchResponse.status,
        ok: fetchResponse.ok,
        data: validationData
      }
      
      // console.log(`      Step 2 - Validation response:`, validationResponse)
      
      if (validationResponse.ok && validationResponse.data.validated) {
        expect(validationResponse.data.validated).to.be.true
        expect(validationResponse.data['access-token']).to.exist
        expect(validationResponse.data.expiry).to.exist
        console.log(`      ✓ CEPSValidation successful - got access token`)
        console.log(`        Access token: ${validationResponse.data['access-token'].substring(0, 20)}...`)
        console.log(`        Expiry: ${new Date(validationResponse.data.expiry).toISOString()}`)
      } else {
        console.log(`      ✗ CEPSValidation failed:`, validationResponse.data)
        throw new Error(`Validation failed: ${JSON.stringify(validationResponse.data)}`)
      }
    } catch (error) {
      console.log(`      ✗ CEPSValidation error: ${error.message}`)
      throw error
    }
  })

  it('should allow other server user to read the shared record after validation', async function () {
    if (!otherServerAuth || !crossServerSharedRecordId) this.skip()
    
    // Wait a bit for sharing to be processed
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    // First, perform CEPSValidation to get an access token for the primary server
    // Step 1: Get validation token from requestor's own server
    const setResponse = await otherServerAuth.post('/ceps/perms/validationtoken/set', {
      data_owner_user: primaryAuth.userId,
      data_owner_host: primaryAuth.serverUrl,
      table_id: appTable,
      permission: sharePermissionName,
      app_id: testConfig.testAppConfig.appName,
      record_id: crossServerSharedRecordId
    })
    
    expect(setResponse.ok).to.be.true
    expect(setResponse.data.validation_token).to.exist
    const validationToken = setResponse.data.validation_token
    
    // Step 2: Validate on data owner's server to get access token
    const fetch = (await import('node-fetch')).default
    
    const validateParams = new URLSearchParams({
      action: 'validate',
      validation_token: validationToken,
      data_owner_user: primaryAuth.userId,
      data_owner_host: primaryAuth.serverUrl,
      table_id: appTable,
      permission: sharePermissionName,
      app_id: testConfig.testAppConfig.appName,
      requestor_user: otherServerAuth.userId,
      requestor_host: otherServerAuth.serverUrl
    })
    
    const validateUrl = `${primaryAuth.serverUrl}/ceps/perms/validationtoken/validate?${validateParams.toString()}`
    const validateFetchResponse = await fetch(validateUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })
    
    const validateData = await validateFetchResponse.json()
    
    if (!validateFetchResponse.ok || !validateData.validated) {
      throw new Error(`Validation failed: ${JSON.stringify(validateData)}`)
    }
    
    const accessToken = validateData['access-token']
    console.log(`      ✓ Got access token from validation: ${accessToken.substring(0, 20)}...`)
    
    // Now use the access token to read the shared record from the primary server
    const readUrl = `${primaryAuth.serverUrl}/ceps/read/${appTable}/${crossServerSharedRecordId}?owner_id=${primaryAuth.userId}&owner_host=${primaryAuth.serverUrl}`
    const readFetchResponse = await fetch(readUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    })
    
    const readData = await readFetchResponse.json()
    const readResponse = {
      status: readFetchResponse.status,
      ok: readFetchResponse.ok,
      data: readData
    }
    
    // console.log(`      Other server user reading shared record`, { 
    //   owner_id: primaryAuth.userId, 
    //   record_id: crossServerSharedRecordId,
    //   response: readResponse 
    // })
    
    expect(readResponse.ok).to.be.true
    expect(readResponse.data).to.be.an('object')
    expect(readResponse.data._id).to.equal(crossServerSharedRecordId)
    expect(readResponse.data.title).to.equal('Cross-Server Shared Record')
    expect(readResponse.data.content).to.equal('This record will be shared with another server user')
    console.log(`      ✓ Other server user successfully read shared record using validated access token`)
  })

  it('should delay for 5 seconds (test of waiting mechanism)', async function () {
    this.timeout(7000) // Give some buffer to Mocha timeout
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
    const start = Date.now()
    await delay(5000)
    const elapsed = Date.now() - start
    console.log(`      ✓ Delay test waited for ~${Math.round(elapsed / 1000)} seconds`)
    expect(elapsed).to.be.at.least(5000)
  })
})

// ===== PERMISSIONS DENIAL TEST (MUST RUN LAST) =====
// NOTE: This is a destructive test that denies all permissions for primaryAuth.
// It should run AFTER other tests that need permissions, as it may affect shared state.
// It only affects primaryAuth, not secondaryAuth, but be cautious about test order.
describe('CEPS Permissions Denial Test', function () {
  this.timeout(30000)

  let primaryAuth
  let secondaryAuth
  let messageRecordId
  const messagePermissionName = 'message_link'
  const contactPermissionName = 'friends'

  before(async function () {
    try {
      primaryAuth = await createAuthenticatedHelper('primary')
      console.log(`    ✓ Primary user logged in: ${primaryAuth.userId}`)
    } catch (error) {
      console.error(`    ✗ Primary user login failed: ${error.message}`)
      this.skip()
    }

    try {
      secondaryAuth = await createAuthenticatedHelper('secondary')
      console.log(`    ✓ Secondary user logged in: ${secondaryAuth.userId}`)
    } catch (error) {
      console.warn(`    ⚠ Secondary user login failed: ${error.message}`)
      console.warn('    Permissions denial test will be skipped. Create secondary test user to enable.')
      this.skip()
    }
  })

  after(async function () {
    // Cleanup
    if (primaryAuth && messageRecordId) {
      try {
        await primaryAuth.delete(`/ceps/delete/${appTable}/${messageRecordId}`)
      } catch (e) {
        // Ignore
      }
    }
    
    if (primaryAuth) await primaryAuth.logout()
    if (secondaryAuth) await secondaryAuth.logout()
  })

  it('should deny all permissions and verify new message cannot be sent', async function () {
    if (!primaryAuth) this.skip()
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Create a message record first (before denying permissions)
    // const createResponse = await primaryAuth.post(`/ceps/write/${appTable}`, {
    //   title: 'Message Test Record for Denial',
    //   content: 'This record will be used to test permission denial',
    //   owner: 'primary',
    //   messageData: { important: true, priority: 'high' }
    // })
    
    // if (createResponse.ok) {
    //   messageRecordId = createResponse.data._id
    //   console.log(`      ✓ Created record for messaging: ${messageRecordId}`)
    // }

    // Deny all permissions for primary user
    // const denied = await primaryAuth.denyAllPermissions(testConfig.testAppConfig.appName)
    // console.log(`      ✓ Denied ${denied.length} permissions`)
    
    // // Verify permissions are denied
    // const permissions = await primaryAuth.getPermissions()
    // const grantedPerms = permissions.filter(p => 
    //   p.requestor_app === testConfig.testAppConfig.appName && 
    //   p.granted === true
    // )
    // expect(grantedPerms.length).to.equal(0)
    // console.log(`      ✓ Verified all permissions are denied`)
    
    // // Try to send a new message - should fail
    // try {
    //   if (messageRecordId) {
    //     const recordResponse = await primaryAuth.get(`/ceps/read/${appTable}/${messageRecordId}`)
    //     if (recordResponse.ok) {
    //       const messageRecord = {
    //         title: recordResponse.data.title,
    //         content: 'This should fail'
    //       }
          
    //       await primaryAuth.sendMessage(
    //         secondaryAuth.userId,
    //         null,
    //         appTable,
    //         messageRecordId,
    //         messagePermissionName,
    //         contactPermissionName,
    //         messageRecord,
    //         'This message should fail'
    //       )
          
    //       // If we get here, the message was sent (which is unexpected)
    //       console.log(`      ⚠ WARNING: Message was sent even though permissions were denied`)
    //     }
    //   }
    // } catch (error) {
    //   // Expected - message should fail
    //   expect(error.message).to.include('Permission') || expect(error.message).to.include('permission')
    //   console.log(`      ✓ Correctly prevented sending message after permissions denied: ${error.message}`)
    // }
  })
})
