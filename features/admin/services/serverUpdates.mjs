// serverUpdates.mjs
// Template for database migrations when server version changes
// 
// HOW TO USE:
// 1. Add a new update object to the SERVER_UPDATES array
// 2. Set 'asOfV' to the version number that requires this update
// 3. Implement the 'execute' async function with migration logic
// 4. The update will run automatically on first startup after version upgrade
//
// IMPORTANT: Updates are run in order, and only if the stored version is older
// than the update's 'asOfV' version number.

import { newVersionNumberIsHigher } from '../../../common/helpers/utils.mjs'

/**
 * Run all pending server updates
 * @param {Object} dsManager - The data store manager instance
 * @param {string} oldVersion - The previously stored version
 * @param {string} newVersion - The current server version
 * @returns {Promise<{success: boolean, updatesRun: number, errors: Array}>}
 */
export async function doUpdates(dsManager, oldVersion, newVersion) {
  const results = {
    success: true,
    updatesRun: 0,
    errors: []
  }

  for (const update of SERVER_UPDATES) {
    if (newVersionNumberIsHigher(oldVersion, update.asOfV)) {
      try {
        console.log(`🔄 Running server update for version ${update.asOfV}...`)
        await update.execute(dsManager)
        results.updatesRun++
        console.log(`✅ Server update for version ${update.asOfV} completed`)
      } catch (err) {
        console.error(`❌ Server update for version ${update.asOfV} failed:`, err.message)
        results.errors.push({ version: update.asOfV, error: err.message })
        results.success = false
        // Continue with other updates even if one fails
      }
    }
  }

  return results
}

/**
 * Server updates array - add new migrations here
 * Each update should have:
 * - asOfV: string - The version number this update applies to
 * - execute: async function(dsManager) - The migration logic
 */
export const SERVER_UPDATES = [
  // EXAMPLE UPDATE (commented out as template):
  //  .. and converted to async without testing - kept for future reference
  // 
  // {
  //   asOfV: '0.0.210',
  //   execute: async (dsManager) => {
  //     // Example: Move public records from fradmin to public user
  //     
  //     const OLD_PUBLIC_OAC = {
  //       owner: 'fradmin',
  //       app_name: 'info.freezr.admin',
  //       collection_name: 'public_records'
  //     }
  //     const NEW_PUBLIC_OAC = {
  //       owner: 'public',
  //       app_name: 'info.freezr.public',
  //       collection_name: 'public_records'
  //     }
  //     
  //     // Get the old and new databases
  //     const oldUserDS = await dsManager.getOrSetUserDS(OLD_PUBLIC_OAC.owner)
  //     const oldPublicDb = await oldUserDS.getorInitDb(OLD_PUBLIC_OAC)
  //     
  //     const newUserDS = await dsManager.getOrSetUserDS(NEW_PUBLIC_OAC.owner)
  //     const newPublicDb = await newUserDS.getorInitDb(NEW_PUBLIC_OAC)
  //     
  //     // Query all old records
  //     const oldRecords = await oldPublicDb.query({}, {})
  //     
  //     // Migrate each record
  //     for (const record of oldRecords) {
  //       const recordId = record._id
  //       delete record._id
  //       
  //       try {
  //         // Create in new location
  //         await newPublicDb.create(recordId, record, {})
  //         // Delete from old location
  //         await oldPublicDb.delete_record(recordId, {})
  //       } catch (err) {
  //         if (err.errorType === 'uniqueViolated') {
  //           // Record already exists in new location, just delete from old
  //           await oldPublicDb.delete_record(recordId, {})
  //         } else {
  //           throw err
  //         }
  //       }
  //     }
  //     
  //     console.log(`Migrated ${oldRecords.length} public records`)
  //   }
  // }
]

export default { doUpdates, SERVER_UPDATES }

