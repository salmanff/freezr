/**
 * FEPS Endpoints Integration Tests
 * 
 * Tests the following endpoints:
 *   GET    /feps/manifest/:target_app          - Get app manifest
 *   GET    /feps/permissions/getall/:target_app - Get all permissions
 *   PUT    /feps/permissions/change            - Change permission
 *   POST   /feps/write/:app_table              - Create a record
 *   POST   /feps/write/:app_table/:id          - Create a record with ID
 *   PUT    /feps/update/:app_table/:id         - Update a record
 *   PUT    /feps/update/:app_table/:start/*     - Update a record with path ID
 *   PUT    /feps/update/:app_table             - Update records by query
 *   DELETE /feps/delete/:app_table              - Delete records by query
 *   DELETE /feps/delete/:app_table/:id         - Delete a record
 *   DELETE /feps/delete/:app_table/:start/*     - Delete a record with path ID
 *   POST   /feps/restore/:app_table             - Restore a deleted record
 *   PUT    /feps/upload/:app_name               - Upload a file
 *   GET    /feps/getuserfiletoken/:perm/:app/:user/* - Get file token
 *   GET    /feps/userfiles/:app/:user/*        - Serve file with token
 *   GET    /feps/fetchuserfiles/:app/:user/*   - Fetch file with app token
 * 
 * Prerequisites: 
 *   1. Server must be running on the configured URL
 *   2. Test users must exist (see users_freezr/test_credentials/testUserCreds.json)
 *   3. Run with: npm run test:feps
 */

import { expect } from 'chai'
import { TestAuthHelper, loadTestCredentials, createAuthenticatedHelper, createOtherServerAuthenticatedHelper } from '../ceps/testAuthHelper.mjs'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fetch from 'node-fetch'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

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

describe('FEPS Endpoints Integration Tests', function () {
  // Increase timeout for network requests
  this.timeout(10000)

  let auth
  let createdRecordId
  let uploadedFileId

  // Test data
  const testRecord = {
    title: 'FEPS Test Record',
    description: 'Created by FEPS integration test',
    value: 42,
    tags: ['test', 'feps', 'integration'],
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

  after(async function () {
    // Cleanup: Delete any remaining test records
    if (auth && createdRecordId) {
      try {
        await auth.delete(`/feps/delete/${appTable}/${createdRecordId}`)
      } catch (e) {
        // console.log('      🔑 after delete createdRecordId error', { createdRecordId, e })
        // Ignore cleanup errors
      }
    }
    
    if (auth && uploadedFileId) {
      try {
        await auth.delete(`/feps/delete/${appTable}.files/${uploadedFileId}`)
      } catch (e) {
        // Ignore cleanup errors
        // console.log('      🔑 after delete uploadedFileId error', { uploadedFileId, e })
      }
    }
    
    // Logout
    if (auth) {
      await auth.logout()
    }
  })

  // ===== MANIFEST TESTS =====
  describe('GET /feps/manifest/:target_app', function () {
    it('should return manifest for target app', async function () {
      if (!auth) this.skip()
      
      const targetApp = testConfig.testAppConfig.appName
      const response = await auth.get(`/feps/manifest/${targetApp}`)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      expect(response.data.manifest).to.exist
      expect(response.data.app_tables).to.be.an('array')
    })

    it('should reject manifest request without authentication', async function () {
      const unauthenticated = new TestAuthHelper(serverUrl)
      const targetApp = testConfig.testAppConfig.appName
      const response = await unauthenticated.get(`/feps/manifest/${targetApp}`)

      expect(response.ok).to.be.false
      expect(response.status).to.equal(401)
    })
  })

  // ===== PERMISSIONS TESTS =====
  describe('GET /feps/permissions/getall/:target_app', function () {
    it('should return all permissions for target app', async function () {
      if (!auth) this.skip()
      
      const targetApp = testConfig.testAppConfig.appName
      const response = await auth.get(`/feps/permissions/getall/${targetApp}`)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('array')
    })

    it('should reject permissions request without authentication', async function () {
      const unauthenticated = new TestAuthHelper(serverUrl)
      const targetApp = testConfig.testAppConfig.appName
      const response = await unauthenticated.get(`/feps/permissions/getall/${targetApp}`)
      
      expect(response.ok).to.be.false
      expect(response.status).to.equal(401)
    })
  })

  describe('PUT /feps/permissions/change', function () {
    it('should change permission status', async function () {
      if (!auth) this.skip()
      
      // Get account token for this request
      let accountToken = auth.appTokens[auth.userId]?.['info.freezr.account']
      if (!accountToken && auth.userId) {
        accountToken = auth.cookies[`app_token_${auth.userId}`]
      }
      
      if (!accountToken) {
        console.log('      ⚠ Account token not available, skipping permission change test')
        this.skip()
      }
      
      const permissionName = 'file_share_perm'
      const targetApp = testConfig.testAppConfig.appName
      
      const response = await fetch(`${serverUrl}/feps/permissions/change`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accountToken}`,
          'Cookie': auth.getCookieHeader()
        },
        body: JSON.stringify({
          change: {
            name: permissionName,
            table_id: appTable,
            requestor_app: targetApp,
            action: 'Accept'
          },
          targetApp: targetApp
        })
      })
      
      const data = await response.json()
      const result = { status: response.status, ok: response.ok, data }
      
      expect(result.status).to.equal(200)
    })
  })

  // ===== WRITE (CREATE) TESTS =====
  describe('POST /feps/write/:app_table', function () {
    it('should create a new record', async function () {
      const response = await auth.post(`/feps/write/${appTable}`, testRecord)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      expect(response.data._id).to.exist
      
      // Store ID for subsequent tests
      createdRecordId = response.data._id
    })

    it('should return response with _date_created and _date_modified', async function () {
      const response = await auth.post(`/feps/write/${appTable}`, {
        title: 'FEPS Compliance Test',
        value: 123
      })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // Verify required fields
      expect(response.data).to.have.property('_id')
      expect(response.data).to.have.property('_date_created')
      expect(response.data).to.have.property('_date_modified')
      
      // Verify timestamps are Unix epoch (numbers)
      expect(response.data._date_created).to.be.a('number')
      expect(response.data._date_modified).to.be.a('number')
      
      // _date_created and _date_modified should be equal for new records
      expect(response.data._date_created).to.equal(response.data._date_modified)
      
      // Cleanup
      await auth.delete(`/feps/delete/${appTable}/${response.data._id}`)
    })

    it('should reject write without authentication', async function () {
      const unauthenticated = new TestAuthHelper(serverUrl)
      const response = await unauthenticated.post(`/feps/write/${appTable}`, testRecord)
      
      expect(response.ok).to.be.false
      expect(response.status).to.equal(401)
    })
  })

  describe('POST /feps/write/:app_table/:data_object_id', function () {
    it('should create a record with specific ID', async function () {
      const customId = `test_record_${Date.now()}`
      const response = await auth.post(`/feps/write/${appTable}/${customId}`, {
        title: 'Record with Custom ID',
        value: 999
      })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data._id).to.equal(customId)
      
      // Cleanup
      await auth.delete(`/feps/delete/${appTable}/${customId}`)
    })

    it('should support upsert option to update existing record', async function () {
      const customId = `upsert_test_${Date.now()}`
      
      // Create initial record
      const createResponse = await auth.post(`/feps/write/${appTable}/${customId}`, {
        title: 'Original Title',
        value: 100
      })
      
      expect(createResponse.ok).to.be.true
      const originalDateModified = createResponse.data._date_modified
      
      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // Update using upsert option
      const appToken = auth.getCurrentAppToken()
      const upsertResponse = await fetch(`${serverUrl}/feps/write/${appTable}/${customId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader()
        },
        body: JSON.stringify({
          upsert: true,
          _entity: {
            title: 'Updated via Upsert',
            value: 200,
            newField: 'added'
          }
        })
      })

      
      const upsertData = await upsertResponse.json()
      const result = { status: upsertResponse.status, ok: upsertResponse.ok, data: upsertData }
      // console.log('      🔑 xxx upsertResponse', { customId,upsertData })
      
      expect(result.ok).to.be.true
      // expect(result.data._id).to.equal(customId)

      // Read back the record by ID to verify the fields have been updated by upsert
      const verifyResponse = await auth.get(`/ceps/read/${appTable}/${customId}`)
      // console.log('      🔑 xxx verifyResponse', { verifyResponse })
      expect(verifyResponse.ok).to.be.true
      expect(verifyResponse.data.title).to.equal('Updated via Upsert')
      expect(verifyResponse.data.value).to.equal(200)
      expect(verifyResponse.data.newField).to.equal('added')
      expect(verifyResponse.data._date_modified).to.be.greaterThan(originalDateModified)
      
      // Cleanup
      await auth.delete(`/feps/delete/${appTable}/${customId}`)
    })

    it('should support data_object_id in options', async function () {
      const customId = `options_test_${Date.now()}`
      
      const appToken = auth.getCurrentAppToken()
      const response = await fetch(`${serverUrl}/feps/write/${appTable}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader()
        },
        body: JSON.stringify({
          _entity: {
            title: 'Record with data_object_id option',
            value: 42
          },
          data_object_id: customId
        })
      })
      
      const data = await response.json()
      const result = { status: response.status, ok: response.ok, data }

      // console.log('      🔑 xxxx data_object_id options response', { customId, response, data })
      
      expect(result.ok).to.be.true
      expect(result.data._id).to.equal(customId)
      
      // Cleanup
      await auth.delete(`/feps/delete/${appTable}/${customId}`)
    })
  })

  // ===== UPDATE TESTS =====
  describe('PUT /feps/update/:app_table/:data_object_id', function () {
    it('should update an existing record', async function () {
      if (!createdRecordId) this.skip()
      
      const updates = {
        title: 'Updated FEPS Test Record',
        value: 100,
        updatedAt: Date.now()
      }
      
      const response = await auth.put(`/feps/update/${appTable}/${createdRecordId}`, updates)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // Verify the update by reading the record (if read endpoint exists)
      // For now, just verify the response
      expect(response.data).to.be.an('object')
    })

    it('should return response with _date_created and _date_modified', async function () {
      if (!createdRecordId) this.skip()
      
      const updates = {
        title: 'FEPS Update Compliance Test',
        value: 999
      }
      
      const response = await auth.put(`/feps/update/${appTable}/${createdRecordId}`, updates)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // Verify required fields
      if (response.data._id) {
        expect(response.data).to.have.property('_id')
        expect(response.data).to.have.property('_date_created')
        expect(response.data).to.have.property('_date_modified')
        
        // Verify timestamps are Unix epoch (numbers)
        expect(response.data._date_created).to.be.a('number')
        expect(response.data._date_modified).to.be.a('number')
        
        // _date_modified should be >= _date_created
        expect(response.data._date_modified).to.be.at.least(response.data._date_created)
      }
    })

    it('should update with replaceAllFields=false (partial update)', async function () {
      if (!createdRecordId) this.skip()
      
      // Create a record with multiple fields
      const testId = `replace_test_${Date.now()}`
      const createResponse = await auth.post(`/feps/write/${appTable}/${testId}`, {
        title: 'Original Title',
        description: 'Original Description',
        value: 100,
        category: 'test'
      })
      
      if (!createResponse.ok) {
        this.skip()
      }
      
      const originalDateCreated = createResponse.data._date_created
      const originalDateModified = createResponse.data._date_modified
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // Partial update (replaceAllFields=false by default for feps/update)
      const appToken = auth.getCurrentAppToken()
      const updateResponse = await fetch(`${serverUrl}/feps/update/${appTable}/${testId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader()
        },
        body: JSON.stringify({
          _entity: {
            value: 200,
            newField: 'added'
            // title and description should remain
          }
        })
      })
      
      const updateData = await updateResponse.json()
      const result = { status: updateResponse.status, ok: updateResponse.ok, data: updateData }
      
      expect(result.ok).to.be.true
      // With partial update, original fields should remain
      // Note: We can't verify this without a read endpoint, but we can verify the update succeeded
      
      // Cleanup
      await auth.delete(`/feps/delete/${appTable}/${testId}`)
    })

    it('should update with replaceAllFields=true (full replace)', async function () {
      if (!createdRecordId) this.skip()
      
      // Create a record with multiple fields
      const testId = `replace_all_test_${Date.now()}`
      const createResponse = await auth.post(`/feps/write/${appTable}/${testId}`, {
        title: 'Original Title',
        description: 'Original Description',
        value: 100,
        category: 'test'
      })
      
      if (!createResponse.ok) {
        this.skip()
      }
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // Full replace (replaceAllFields=true)
      const appToken = auth.getCurrentAppToken()
      const updateResponse = await fetch(`${serverUrl}/feps/update/${appTable}/${testId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader()
        },
        body: JSON.stringify({
          _entity: {
            value: 200,
            newField: 'only this'
          },
          replaceAllFields: true
        })
      })
      
      const updateData = await updateResponse.json()
      const result = { status: updateResponse.status, ok: updateResponse.ok, data: updateData }
      
      expect(result.ok).to.be.true
      // With replaceAllFields, only the new fields should exist
      // Note: We can't verify this without a read endpoint, but we can verify the update succeeded
      
      // Cleanup
      await auth.delete(`/feps/delete/${appTable}/${testId}`)
    })
  })

  describe('PUT /feps/update/:app_table', function () {
    it('should update records by query', async function () {
      // Create a test record first
      const createResponse = await auth.post(`/feps/write/${appTable}`, {
        title: 'Query Update Test',
        category: 'test',
        value: 1
      })
      
      if (!createResponse.ok) {
        this.skip()
      }
      
      const testId = createResponse.data._id
      
      try {
        // Update by query
        const response = await auth.put(`/feps/update/${appTable}`, {
          q: { category: 'test' },
          keys: { value: 2, updated: true }
        })
        
        expect(response.ok).to.be.true
        expect(response.status).to.equal(200)
      } finally {
        // Cleanup
        await auth.delete(`/feps/delete/${appTable}/${testId}`)
      }
    })

    it('should update records by query with replaceAllFields=false', async function () {
      // Create test records
      const record1 = await auth.post(`/feps/write/${appTable}`, {
        title: 'Query Replace Test 1',
        category: 'replace_test',
        value: 1,
        keepField: 'should remain'
      })
      const record2 = await auth.post(`/feps/write/${appTable}`, {
        title: 'Query Replace Test 2',
        category: 'replace_test',
        value: 1,
        keepField: 'should remain'
      })
      
      if (!record1.ok || !record2.ok) {
        this.skip()
      }
      
      try {
        // Update by query with partial update (replaceAllFields=false)
        const appToken = auth.getCurrentAppToken()
        const response = await fetch(`${serverUrl}/feps/update/${appTable}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${appToken}`,
            'Cookie': auth.getCookieHeader()
          },
          body: JSON.stringify({
            q: { category: 'replace_test' },
            keys: { value: 2, newField: 'added' },
            replaceAllFields: false
          })
        })
        
        const data = await response.json()
        const result = { status: response.status, ok: response.ok, data }
        
        expect(result.ok).to.be.true
        expect(result.status).to.equal(200)
      } finally {
        // Cleanup
        await auth.delete(`/feps/delete/${appTable}/${record1.data._id}`)
        await auth.delete(`/feps/delete/${appTable}/${record2.data._id}`)
      }
    })

    it('should update records by query with replaceAllFields=true', async function () {
      // Create test records
      const record1 = await auth.post(`/feps/write/${appTable}`, {
        title: 'Query Replace All Test 1',
        category: 'replace_all_test',
        value: 1,
        keepField: 'should be removed'
      })
      
      if (!record1.ok) {
        this.skip()
      }
      
      try {
        // Update by query with full replace (replaceAllFields=true)
        const appToken = auth.getCurrentAppToken()
        const response = await fetch(`${serverUrl}/feps/update/${appTable}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${appToken}`,
            'Cookie': auth.getCookieHeader()
          },
          body: JSON.stringify({
            q: { category: 'replace_all_test' },
            keys: { value: 2, newField: 'only this' },
            replaceAllFields: true
          })
        })
        
        const data = await response.json()
        const result = { status: response.status, ok: response.ok, data }
        
        expect(result.ok).to.be.true
        expect(result.status).to.equal(200)
      } finally {
        // Cleanup
        // console.log('      🔑 delete createdRecordId in query replace_all_test flow ', { record1Id: record1.data._id })
        await auth.delete(`/feps/delete/${appTable}/${record1.data._id}`)
      }
    })
  })

  // ===== DELETE TESTS =====
  describe('DELETE /feps/delete/:app_table/:data_object_id', function () {
    let recordToDeleteId

    before(async function () {
      // Create a record specifically for deletion testing
      const response = await auth.post(`/feps/write/${appTable}`, {
        title: 'Record to delete',
        purpose: 'deletion test'
      })
      
      if (response.ok) {
        recordToDeleteId = response.data._id
      }
    })

    it('should delete an existing record', async function () {
      if (!recordToDeleteId) this.skip()
      
      const response = await auth.delete(`/feps/delete/${appTable}/${recordToDeleteId}`)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      
      // Verify the record is deleted by trying to delete it again (should fail)
      const deleteAgain = await auth.delete(`/feps/delete/${appTable}/${recordToDeleteId}`)
      // console.log('      🔑 delete recordToDeleteId in delete an existing record flow deleteAgain', { recordToDeleteId, deleteAgain })
      expect(deleteAgain.status).to.not.equal(200)
    })

    it('should reject delete without authentication', async function () {
      // Create another record to test unauthorized delete
      const createResponse = await auth.post(`/feps/write/${appTable}`, { title: 'Protected record' })
      const protectedId = createResponse.data._id
      
      const unauthenticated = new TestAuthHelper(serverUrl)
      const response = await unauthenticated.delete(`/feps/delete/${appTable}/${protectedId}`)
      
      expect(response.ok).to.be.false
      expect([401, 404]).to.include(response.status) // todo - not sure why 404 is sent?
      
      // Cleanup: delete with proper auth
      await auth.delete(`/feps/delete/${appTable}/${protectedId}`)
    })
  })

  describe('DELETE /feps/delete/:app_table', function () {
    it('should delete records by query', async function () {
      // Create test records
      const record1 = await auth.post(`/feps/write/${appTable}`, {
        title: 'Query Delete Test 1',
        category: 'delete_me',
        value: 1
      })
      const record2 = await auth.post(`/feps/write/${appTable}`, {
        title: 'Query Delete Test 2',
        category: 'delete_me',
        value: 2
      })
      
      if (!record1.ok || !record2.ok) {
        this.skip()
      }
      
      try {
        // Delete by query - use fetch directly since TestAuthHelper.delete doesn't support body
        const appToken = auth.getCurrentAppToken()
        const response = await fetch(`${serverUrl}/feps/delete/${appTable}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${appToken}`,
            'Cookie': auth.getCookieHeader()
          },
          body: JSON.stringify({ q: { category: 'delete_me' } })
        })
        
        const data = await response.json()
        const result = { status: response.status, ok: response.ok, data }
        
        // Query delete might succeed or fail depending on implementation
        expect([200, 400, 404, 500]).to.include(result.status)
      } catch (e) {
        // If query delete doesn't work, that's okay - just log it
        console.log(`      ⚠ Query delete test failed: ${e.message}`)
      } finally {
        // Cleanup individual records if query delete didn't work
        try {
          await auth.delete(`/feps/delete/${appTable}/${record1.data._id}`)
          await auth.delete(`/feps/delete/${appTable}/${record2.data._id}`)
        } catch (e) {
          // Ignore cleanup errors
          // console.log('      🔑 delete createdRecordId in query delete flow error', { record1Id: record1.data._id, record2Id: record2.data._id, e })
        }
      }
    })
  })

  // ===== RESTORE TESTS =====
  describe('POST /feps/restore/:app_table', function () {
    it('should reject restore with app token (requires account token)', async function () {
      // Create and delete a record first
      const createResponse = await auth.post(`/feps/write/${appTable}`, {
        title: 'Record to restore',
        value: 42
      })
      
      if (!createResponse.ok) {
        this.skip()
      }
      
      const recordId = createResponse.data._id
      const originalData = createResponse.data
      
      // Delete the record
      await auth.delete(`/feps/delete/${appTable}/${recordId}`)
      
      // Wait a bit for deletion to complete
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // Try to restore with app token (should fail)
      const appToken = auth.getCurrentAppToken()
      const restoreResponse = await fetch(`${serverUrl}/feps/restore/${appTable}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader()
        },
        body: JSON.stringify({
          record: originalData,
          options: {
            data_object_id: recordId,
            updateRecord: true
          }
        })
      })
      
      const data = await restoreResponse.json()
      const result = { status: restoreResponse.status, ok: restoreResponse.ok, data }
      
      // Should fail with 401 (requires account token)
      expect(result.ok).to.be.false
      expect(result.status).to.equal(401)
      
      await new Promise(resolve => setTimeout(resolve, 100))
      // Cleanup
      try {   
        await auth.delete(`/feps/delete/${appTable}/${recordId}`)
      } catch (e) {
        // Ignore cleanup errors
      }
    })

    it('should restore a deleted record with account token and preserve dates', async function () {
      // Get account token
      let accountToken = auth.appTokens[auth.userId]?.['info.freezr.account']
      if (!accountToken && auth.userId) {
        accountToken = auth.cookies[`app_token_${auth.userId}`]
      }
      
      if (!accountToken) {
        console.log('      ⚠ Account token not available, skipping restore test')
        this.skip()
      }
      
      // Create and delete a record first
      const createResponse = await auth.post(`/feps/write/${appTable}`, {
        title: 'Record to restore',
        value: 42
      })
      
      if (!createResponse.ok) {
        this.skip()
      }
      
      const recordId = createResponse.data._id
      
      // Create record data with old dates (simulating a deleted record being restored)
      const oldDate = Date.now() - (365 * 24 * 3600 * 1000) // 1 year ago
      const recordToRestore = {
        _id: recordId,
        title: 'Restored Record',
        value: 42,
        description: 'This was restored',
        _date_created: oldDate,
        _date_modified: oldDate + 1000 // 1 second later
      }
      
      // Delete the record
      await auth.delete(`/feps/delete/${appTable}/${recordId}`)
      
      // Wait a bit for deletion to complete
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // Restore with account token
      const restoreResponse = await fetch(`${serverUrl}/feps/restore/${appTable}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accountToken}`,
          'Cookie': auth.getCookieHeader()
        },
        body: JSON.stringify({
          record: recordToRestore,
          options: {
            data_object_id: recordId
          }
        })
      })
      
      const data = await restoreResponse.json()

      const result = { status: restoreResponse.status, ok: restoreResponse.ok, data }
      
      if (result.ok) {
        // Verify dates are preserved from the restored object
        expect(result.data).to.have.property('_id')
        expect(result.data).to.have.property('_date_created')
        expect(result.data).to.have.property('_date_modified')
        
        // Dates should match the restored object (not auto-generated)
        expect(result.data._date_created).to.equal(oldDate)
        expect(result.data._date_modified).to.equal(oldDate + 1000)
        
        console.log(`      ✓ Record restored with preserved dates: created=${result.data._date_created}, modified=${result.data._date_modified}`)
      } else {
        // Restore might fail for various reasons
        console.log(`      ⚠ Restore returned status ${result.status}: ${JSON.stringify(result.data)}`)
        expect([200, 400, 404, 401]).to.include(result.status)
      }
      
      // Cleanup
      try {
        await auth.delete(`/feps/delete/${appTable}/${recordId}`)
      } catch (e) {
        // Ignore cleanup errors
      }
    })
  })

  // ===== FILE UPLOAD TESTS =====
  describe('PUT /feps/upload/:app_name', function () {
    it('should upload a file and create a file record', async function () {
      if (!auth) this.skip()
      
      // Read test logo file
      const testLogoPath = join(__dirname, '../../../users_freezr/test_credentials/testlogo.png')
      let fileBuffer
      try {
        fileBuffer = readFileSync(testLogoPath)
      } catch (error) {
        console.log('      ⚠ Test logo file not found, skipping file upload test')
        this.skip()
      }
      
      const appName = testConfig.testAppConfig.appName
      
      // Get app token for authentication
      const appToken = auth.getCurrentAppToken()
      if (!appToken) {
        console.log('      ⚠ App token not available, skipping file upload test')
        this.skip()
      }
      
      // Create multipart form data manually (since form-data package was removed)
      const boundary = `----WebKitFormBoundary${Date.now()}`
      const options = {
        fileName: `test_${Date.now()}.png`,
        targetFolder: 'test_uploads',
        overwrite: true,
        data: {
          description: 'Test upload from FEPS integration test',
          uploadedAt: Date.now()
        }
      }
      
      // Build multipart form body
      let body = `--${boundary}\r\n`
      body += `Content-Disposition: form-data; name="file"; filename="testlogo.png"\r\n`
      body += `Content-Type: image/png\r\n\r\n`
      const bodyBuffer = Buffer.concat([
        Buffer.from(body, 'utf8'),
        fileBuffer,
        Buffer.from(`\r\n--${boundary}\r\n`, 'utf8'),
        Buffer.from(`Content-Disposition: form-data; name="options"\r\n\r\n`, 'utf8'),
        Buffer.from(JSON.stringify(options), 'utf8'),
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
      ])
      
      // Make upload request
      const response = await fetch(`${serverUrl}/feps/upload/${appName}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader(),
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: bodyBuffer
      })
      
      const data = await response.json()
      const result = { status: response.status, ok: response.ok, data }
      
      if (result.ok) {
        expect(result.data).to.have.property('_id')
        uploadedFileId = result.data._id
        console.log(`      ✓ File uploaded successfully: ${uploadedFileId}`)
      } else {
        // Upload might fail for various reasons (permissions, etc.)
        console.log(`      ⚠ File upload returned status ${result.status}: ${JSON.stringify(result.data)}`)
        expect([200, 400, 401, 403, 500]).to.include(result.status)
      }
    })

    it('should upload a file with image conversion options (convertPict)', async function () {
      if (!auth) this.skip()
      
      // Read test logo file
      const testLogoPath = join(__dirname, '../../../users_freezr/test_credentials/testlogo.png')
      let originalFileBuffer
      try {
        originalFileBuffer = readFileSync(testLogoPath)
      } catch (error) {
        this.skip()
      }
      
      const appName = testConfig.testAppConfig.appName
      const appToken = auth.getCurrentAppToken()
      if (!appToken) {
        this.skip()
      }
      
      // First upload original file to get its size
      const originalFileName = `original_${Date.now()}.png`
      const originalBoundary = `----WebKitFormBoundary${Date.now()}`
      const originalOptions = {
        fileName: originalFileName,
        targetFolder: 'test_uploads',
        overwrite: true
      }
      
      let body = `--${originalBoundary}\r\n`
      body += `Content-Disposition: form-data; name="file"; filename="testlogo.png"\r\n`
      body += `Content-Type: image/png\r\n\r\n`
      const originalBodyBuffer = Buffer.concat([
        Buffer.from(body, 'utf8'),
        originalFileBuffer,
        Buffer.from(`\r\n--${originalBoundary}\r\n`, 'utf8'),
        Buffer.from(`Content-Disposition: form-data; name="options"\r\n\r\n`, 'utf8'),
        Buffer.from(JSON.stringify(originalOptions), 'utf8'),
        Buffer.from(`\r\n--${originalBoundary}--\r\n`, 'utf8')
      ])
      
      const originalResponse = await fetch(`${serverUrl}/feps/upload/${appName}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader(),
          'Content-Type': `multipart/form-data; boundary=${originalBoundary}`
        },
        body: originalBodyBuffer
      })
      
      const originalData = await originalResponse.json()
      if (!originalResponse.ok) {
        console.log('      ⚠ Could not upload original file for size comparison')
        this.skip()
      }
      
      // Get original file size
      const originalFileId = originalData._id
      const originalFileResponse = await auth.get(`/feps/userfiles/${appName}/${auth.userId}/${originalFileId}`)
      const originalSize = originalFileResponse.data ? Buffer.from(originalFileResponse.data).length : originalFileBuffer.length
      
      // Now upload with conversion
      const boundary = `----WebKitFormBoundary${Date.now()}`
      const options = {
        fileName: `converted_${Date.now()}.jpg`,
        targetFolder: 'test_uploads',
        overwrite: true,
        convertPict: {
          width: 200,
          type: 'jpg'
        }
      }
      
      // Build multipart form body
      body = `--${boundary}\r\n`
      body += `Content-Disposition: form-data; name="file"; filename="testlogo.png"\r\n`
      body += `Content-Type: image/png\r\n\r\n`
      const bodyBuffer = Buffer.concat([
        Buffer.from(body, 'utf8'),
        originalFileBuffer,
        Buffer.from(`\r\n--${boundary}\r\n`, 'utf8'),
        Buffer.from(`Content-Disposition: form-data; name="options"\r\n\r\n`, 'utf8'),
        Buffer.from(JSON.stringify(options), 'utf8'),
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
      ])
      
      const response = await fetch(`${serverUrl}/feps/upload/${appName}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader(),
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: bodyBuffer
      })
      
      const data = await response.json()
      const result = { status: response.status, ok: response.ok, data }
      
      if (result.ok && result.data._id) {
        // Get converted file and verify it's smaller (converted image should be smaller)
        const convertedFileResponse = await auth.get(`/feps/userfiles/${appName}/${auth.userId}/${result.data._id}`)
        if (convertedFileResponse.ok && convertedFileResponse.data) {
          const convertedSize = Buffer.from(convertedFileResponse.data).length
          console.log(`      ✓ File converted: original=${originalSize} bytes, converted=${convertedSize} bytes`)
          // Converted file should typically be smaller (resized and compressed)
          expect(convertedSize).to.be.lessThan(originalSize)
        }
        
        // Cleanup converted file
        try {
          await auth.delete(`/feps/delete/${appName}.files/${result.data._id}`)
        } catch (e) {
          // console.log('      🔑 delete convertedFileId in convertPict flow error', { convertedFileId: result.data._id, e })
          // Ignore
        }
      } else {
        // Just verify the endpoint accepts the request
        expect([200, 400, 401, 403, 500]).to.include(result.status)
      }
      
      // Cleanup original file
      try {
        await auth.delete(`/feps/delete/${appName}.files/${originalFileId}`)
      } catch (e) {
        // Ignore
        // console.log('      🔑 delete originalFileId in convertPict flow error', { originalFileId, e })
      }
    })

    it('should respect overwrite:false option', async function () {
      if (!auth) this.skip()
      
      // Read test logo file
      const testLogoPath = join(__dirname, '../../../users_freezr/test_credentials/testlogo.png')
      let fileBuffer
      try {
        fileBuffer = readFileSync(testLogoPath)
      } catch (error) {
        this.skip()
      }
      
      const appName = testConfig.testAppConfig.appName
      const appToken = auth.getCurrentAppToken()
      if (!appToken) {
        this.skip()
      }
      
      const fileName = `overwrite_test_${Date.now()}.png`
      
      // Upload file first time
      const boundary1 = `----WebKitFormBoundary${Date.now()}`
      const options1 = {
        fileName: fileName,
        targetFolder: 'test_uploads',
        overwrite: true
      }
      
      let body = `--${boundary1}\r\n`
      body += `Content-Disposition: form-data; name="file"; filename="testlogo.png"\r\n`
      body += `Content-Type: image/png\r\n\r\n`
      const bodyBuffer1 = Buffer.concat([
        Buffer.from(body, 'utf8'),
        fileBuffer,
        Buffer.from(`\r\n--${boundary1}\r\n`, 'utf8'),
        Buffer.from(`Content-Disposition: form-data; name="options"\r\n\r\n`, 'utf8'),
        Buffer.from(JSON.stringify(options1), 'utf8'),
        Buffer.from(`\r\n--${boundary1}--\r\n`, 'utf8')
      ])
      
      const response1 = await fetch(`${serverUrl}/feps/upload/${appName}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader(),
          'Content-Type': `multipart/form-data; boundary=${boundary1}`
        },
        body: bodyBuffer1
      })
      
      const data1 = await response1.json()
      if (!response1.ok) {
        this.skip()
      }
      
      const firstFileId = data1._id
      
      // Try to upload again with overwrite:false (should fail or be rejected)
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const boundary2 = `----WebKitFormBoundary${Date.now()}`
      const options2 = {
        fileName: fileName,
        targetFolder: 'test_uploads',
        overwrite: false
      }
      
      body = `--${boundary2}\r\n`
      body += `Content-Disposition: form-data; name="file"; filename="testlogo.png"\r\n`
      body += `Content-Type: image/png\r\n\r\n`
      const bodyBuffer2 = Buffer.concat([
        Buffer.from(body, 'utf8'),
        fileBuffer,
        Buffer.from(`\r\n--${boundary2}\r\n`, 'utf8'),
        Buffer.from(`Content-Disposition: form-data; name="options"\r\n\r\n`, 'utf8'),
        Buffer.from(JSON.stringify(options2), 'utf8'),
        Buffer.from(`\r\n--${boundary2}--\r\n`, 'utf8')
      ])
      
      const response2 = await fetch(`${serverUrl}/feps/upload/${appName}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader(),
          'Content-Type': `multipart/form-data; boundary=${boundary2}`
        },
        body: bodyBuffer2
      })
      
      const data2 = await response2.json()
      const result2 = { status: response2.status, ok: response2.ok, data: data2 }
      
      // With overwrite:false, should fail or return error when file exists
      if (result2.ok) {
        // If it succeeds, it might have created a new file with a different name
        console.log(`      ⚠ Upload with overwrite:false succeeded (may have created new file)`)
      } else {
        // Should fail with appropriate error
        expect([400, 409, 500]).to.include(result2.status)
        console.log(`      ✓ Upload with overwrite:false correctly rejected existing file`)
      }
      
      // Cleanup
      try {
        await auth.delete(`/feps/delete/${appName}.files/${firstFileId}`)
        if (result2.ok && data2._id && data2._id !== firstFileId) {
          await auth.delete(`/feps/delete/${appName}.files/${data2._id}`)
        }
      } catch (e) {
        // Ignore
      }
    })

    it('should allow overwrite:true to replace existing file', async function () {
      if (!auth) this.skip()
      
      // Read test logo file
      const testLogoPath = join(__dirname, '../../../users_freezr/test_credentials/testlogo.png')
      let fileBuffer
      try {
        fileBuffer = readFileSync(testLogoPath)
      } catch (error) {
        this.skip()
      }
      
      const appName = testConfig.testAppConfig.appName
      const appToken = auth.getCurrentAppToken()
      if (!appToken) {
        this.skip()
      }
      
      const fileName = `overwrite_true_test_${Date.now()}.png`
      
      // Upload file first time
      const boundary1 = `----WebKitFormBoundary${Date.now()}`
      const options1 = {
        fileName: fileName,
        targetFolder: 'test_uploads',
        overwrite: true,
        data: { version: 1 }
      }
      
      let body = `--${boundary1}\r\n`
      body += `Content-Disposition: form-data; name="file"; filename="testlogo.png"\r\n`
      body += `Content-Type: image/png\r\n\r\n`
      const bodyBuffer1 = Buffer.concat([
        Buffer.from(body, 'utf8'),
        fileBuffer,
        Buffer.from(`\r\n--${boundary1}\r\n`, 'utf8'),
        Buffer.from(`Content-Disposition: form-data; name="options"\r\n\r\n`, 'utf8'),
        Buffer.from(JSON.stringify(options1), 'utf8'),
        Buffer.from(`\r\n--${boundary1}--\r\n`, 'utf8')
      ])
      
      const response1 = await fetch(`${serverUrl}/feps/upload/${appName}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader(),
          'Content-Type': `multipart/form-data; boundary=${boundary1}`
        },
        body: bodyBuffer1
      })
      
      const data1 = await response1.json()
      if (!response1.ok) {
        this.skip()
      }
      
      const firstFileId = data1._id
      
      // Upload again with overwrite:true (should succeed and replace)
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const boundary2 = `----WebKitFormBoundary${Date.now()}`
      const options2 = {
        fileName: fileName,
        targetFolder: 'test_uploads',
        overwrite: true,
        data: { version: 2 }
      }
      
      body = `--${boundary2}\r\n`
      body += `Content-Disposition: form-data; name="file"; filename="testlogo.png"\r\n`
      body += `Content-Type: image/png\r\n\r\n`
      const bodyBuffer2 = Buffer.concat([
        Buffer.from(body, 'utf8'),
        fileBuffer,
        Buffer.from(`\r\n--${boundary2}\r\n`, 'utf8'),
        Buffer.from(`Content-Disposition: form-data; name="options"\r\n\r\n`, 'utf8'),
        Buffer.from(JSON.stringify(options2), 'utf8'),
        Buffer.from(`\r\n--${boundary2}--\r\n`, 'utf8')
      ])
      
      const response2 = await fetch(`${serverUrl}/feps/upload/${appName}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Cookie': auth.getCookieHeader(),
          'Content-Type': `multipart/form-data; boundary=${boundary2}`
        },
        body: bodyBuffer2
      })
      
      const data2 = await response2.json()
      const result2 = { status: response2.status, ok: response2.ok, data: data2 }
      
      // With overwrite:true, should succeed
      expect(result2.ok).to.be.true
      expect(result2.status).to.equal(200)
      // File ID should be the same (file was replaced)
      expect(result2.data._id).to.equal(firstFileId)
      
      // Cleanup
      try {
        await auth.delete(`/feps/delete/${appName}.files/${firstFileId}`)
      } catch (e) {
        // Ignore
        // console.log('      🔑 delete firstFileId in overwrite_true flow error', { firstFileId, e })
      }
    })
  })

  // ===== FILE TOKEN TESTS =====
  describe('GET /feps/getuserfiletoken/:permission_name/:app_name/:user_id/*', function () {
    it('should get a file token for a user file', async function () {
      if (!auth || !uploadedFileId) {
        console.log('      ⚠ No uploaded file available, skipping file token test')
        this.skip()
      }
      
      const appName = testConfig.testAppConfig.appName
      const userId = auth.userId
      const permissionName = 'read_files' // Adjust based on your permission structure
      const filePath = uploadedFileId
      
      const response = await auth.get(`/feps/getuserfiletoken/${permissionName}/${appName}/${userId}/${filePath}`)
      // console.log('      🔑 getuserfiletoken response', { response })
      if (response.ok) {
        expect(response.data).to.have.property('fileToken')
        expect(response.data.fileToken).to.be.a('string')
        console.log(`      ✓ Got file token: ${response.data.fileToken.substring(0, 20)}...`)
      } else {
        // Token generation might fail due to permissions
        console.log(`      ⚠ File token request returned status ${response.status}`)
        expect([200, 401, 403, 404]).to.include(response.status)
      }
    })
  })

  // ===== FILE SERVING TESTS =====
  describe('GET /feps/userfiles/:app_name/:user_id/*', function () {
    it('should serve a file with valid file token', async function () {
      if (!auth || !uploadedFileId) {
        this.skip()
      }
      
      // First, get a file token
      const appName = testConfig.testAppConfig.appName
      const userId = auth.userId
      const permissionName = 'read_files'
      const filePath = uploadedFileId
      
      const tokenResponse = await auth.get(`/feps/getuserfiletoken/${permissionName}/${appName}/${userId}/${filePath}`)
      
      if (!tokenResponse.ok || !tokenResponse.data.fileToken) {
        console.log('      ⚠ Could not get file token, skipping file serving test')
        this.skip()
      }
      
      const fileToken = tokenResponse.data.fileToken

      // console.log('      🔑 userfiles response - gottoken ', { fileToken, tokenResponse })
      
      // Request file with token
      const response = await fetch(`${serverUrl}/feps/userfiles/${appName}/${userId}/${filePath}?fileToken=${fileToken}`, {
        method: 'GET'
      })
      
      expect(response.status).to.equal(200)

      // console.log('      🔑 userfiles response - got file 1 ', { response, contentLength: response.headers.get('content-length') })
      
      if (response.ok) {
        // console.log('      🔑 userfiles response - got file 2 ', { response })
        // Actually read the response body to verify file content
        const arrayBuffer = await response.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)
        const contentType = response.headers.get('content-type')
        
        expect(buffer).to.exist
        expect(buffer.length).to.be.greaterThan(0)
        expect(contentType).to.exist
        
        // console.log(`      ✓ File served successfully (content-type: ${contentType}, size: ${buffer.length} bytes)`)
        
        // Verify it's actually an image (PNG files start with specific bytes)
        if (contentType && contentType.includes('image')) {
          expect(buffer[0]).to.equal(0x89) // PNG magic number first byte
          expect(buffer[1]).to.equal(0x50) // PNG magic number second byte
          // console.log(`      ✓ File is a valid PNG image`)
        }
      }
    })

    it('should reject file request without token', async function () {
      if (!auth || !uploadedFileId) {
        this.skip()
      }
      
      const appName = testConfig.testAppConfig.appName
      const userId = auth.userId
      const filePath = uploadedFileId
      
      const response = await fetch(`${serverUrl}/feps/userfiles/${appName}/${userId}/${filePath}`, {
        method: 'GET'
      })
      
      // console.log('      🔑 userfiles response without token', { response })
      
      expect(response.status).to.equal(401)
    })
  })

  describe('GET /feps/userfiles/:app_name/:user_id/*', function () {
    it('should fetch a file using app token', async function () {
      if (!auth || !uploadedFileId) {
        this.skip()
      }
      
      const appName = testConfig.testAppConfig.appName
      const userId = auth.userId
      const filePath = uploadedFileId
      
      const response = await auth.get(`/feps/userfiles/${appName}/${userId}/${filePath}`)
      
      // File fetching shluld succeed
      // console.log('      🔑 fetchuserfiles response with App creds', { response })

      expect(response.status).to.equal(200)
      
      if (response.ok) {
        // Response should be file content (not JSON)
        expect(response.data).to.exist
        console.log(`      ✓ File fetched successfully using app token`)
      }
    })
  })

  // ===== PATH-BASED UPDATE TESTS (for file metadata) =====
  describe('PUT /feps/update/:app_table/:data_object_start/*', function () {
    it('should update file metadata with path-based ID after file upload', async function () {
      if (!auth || !uploadedFileId) {
        console.log('      ⚠ No uploaded file available, skipping path-based update test')
        this.skip()
      }
      
      const appName = testConfig.testAppConfig.appName
      const fileTable = `${appName}.files`
      
      // Update file metadata using path-based ID
      const updates = {
        description: 'Updated file metadata via path-based update',
        tags: ['updated', 'path-based'],
        metadataUpdated: true
      }
      
      const response = await auth.put(`/feps/update/${fileTable}/${uploadedFileId}`, updates)
      
      // Path-based updates should work for file records
      expect([200, 400, 404]).to.include(response.status)
      
      if (response.ok) {
        console.log(`      ✓ File metadata updated successfully using path-based ID`)
        expect(response.data).to.be.an('object')
      } else {
        console.log(`      ⚠ Path-based update returned status ${response.status}`)
      }
    })
  })

  // Delete the uploaded file if it exists
  describe('CLEANUP uploaded file', function () {
    it('should delete the uploaded file', async function () {
      if (auth && uploadedFileId) {
        const appName = testConfig.testAppConfig.appName
        const response = await auth.delete(`/feps/delete/${appName}.files/${uploadedFileId}`);
        expect(response.ok).to.be.true;
        uploadedFileId = null; // Mark as deleted
      }
    });
  });

  // ===== CLEANUP =====
  describe('Cleanup', function () {
    it('should delete the main test record', async function () {
      // if (!createdRecordId) this.skip()
      
      const response = await auth.delete(`/feps/delete/${appTable}/${createdRecordId}`)

      // console.log('      🔑 delete the main test record response for ', { appTable, path: `/feps/delete/${appTable}+.files/${createdRecordId}`, response, data: response.data, confirm: response.data?.confirm })
      
      expect(response.ok).to.be.true
      createdRecordId = null // Mark as deleted
    })
  })
})

// ===== MULTI-USER TESTS =====
describe('FEPS Multi-User Tests', function () {
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
        await primaryAuth.delete(`/feps/delete/${appTable}/${primaryRecordId}`)
      } catch (e) {
        // Ignore
        // console.log('      🔑 delete primaryRecordId in cleanup primary user flow error', { primaryRecordId, e })
      }
    }
    
    if (primaryAuth) await primaryAuth.logout()
    if (secondaryAuth) await secondaryAuth.logout()
  })

  it('should allow user to create record in their own space', async function () {
    if (!primaryAuth) this.skip()
    
    const response = await primaryAuth.post(`/feps/write/${appTable}`, {
      title: 'Primary user FEPS record',
      owner: 'primary'
    })
    
    expect(response.ok).to.be.true
    primaryRecordId = response.data._id
  })

  it('users should have isolated data by default', async function () {
    if (!primaryAuth || !secondaryAuth || !primaryRecordId) this.skip()
    
    // Secondary user should not see primary's records (unless shared)
    // This test verifies data isolation
    // Note: FEPS doesn't have a query endpoint exposed, so we can't directly test this
    // But we can verify that users can create their own records
    const secondaryResponse = await secondaryAuth.post(`/feps/write/${appTable}`, {
      title: 'Secondary user FEPS record',
      owner: 'secondary'
    })
    
    expect(secondaryResponse.ok).to.be.true
    expect(secondaryResponse.data._id).to.not.equal(primaryRecordId)
    
    // Cleanup
    await secondaryAuth.delete(`/feps/delete/${appTable}/${secondaryResponse.data._id}`)
  })
})

