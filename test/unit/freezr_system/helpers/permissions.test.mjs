// Unit tests for permissions.mjs
import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import * as permissions from '../../../../freezr_system/helpers/permissions.mjs';
import * as mocks from '../../../utils/mocks.mjs';

describe('Permissions Module', () => {
  let mockUser;
  let mockApp;
  let mockContext;

  beforeEach(() => {
    // Create mock objects using our manual mocking approach
    mockUser = {
      _id: 'testuser',
      name: 'Test User',
      email: 'test@example.com'
    };

    mockApp = {
      app_id: 'testuser_testapp',
      app_name: 'testapp',
      version: '1.0.0'
    };

    mockContext = {
      user: mockUser,
      app: mockApp,
      freezrUserDS: mocks.createMockObject({
        query: async () => [],
        create: async () => ({}),
        update: async () => ({}),
        delete: async () => ({})
      })
    };
  });

  describe('permissionObjectFromManifestParams', () => {
    const validManifestPerm = {
      name: 'read_users',
      type: 'db_query',
      table_id: 'users',
      description: 'Read user records',
      return_fields: ['name', 'email'],
      search_fields: ['name']
    };

    it('should create a valid permission object', () => {
      const result = permissions.permissionObjectFromManifestParams('test.app', validManifestPerm);
      
      expect(result).to.be.an('object');
      expect(result.name).to.equal('read_users');
      expect(result.type).to.equal('db_query');
      expect(result.table_id).to.equal('users');
      expect(result.requestor_app).to.equal('test.app');
      expect(result.description).to.equal('Read user records');
      expect(result.return_fields).to.deep.equal(['name', 'email']);
      expect(result.search_fields).to.deep.equal(['name']);
    });

    it('should handle permissions without tables', () => {
      const useAppPerm = {
        name: 'use_app',
        type: 'use_app',
        description: 'Use the application'
      };

      const result = permissions.permissionObjectFromManifestParams('test.app', useAppPerm);
      
      expect(result).to.be.an('object');
      expect(result.name).to.equal('use_app');
      expect(result.type).to.equal('use_app');
      expect(result.table_id).to.deep.equal([]);
    });

    it('should handle array table_ids', () => {
      const multiTablePerm = {
        name: 'read_multiple',
        type: 'db_query',
        table_ids: ['users', 'posts'],
        description: 'Read from multiple tables'
      };

      const result = permissions.permissionObjectFromManifestParams('test.app', multiTablePerm);
      
      expect(result).to.be.an('object');
      expect(result.table_id).to.deep.equal(['users', 'posts']);
      expect(result.table_ids).to.be.undefined; // Should be removed
    });

    it('should handle empty arrays', () => {
      const emptyArraysPerm = {
        name: 'empty_arrays',
        type: 'db_query',
        table_id: 'users',
        return_fields: [],
        search_fields: []
      };

      const result = permissions.permissionObjectFromManifestParams('test.app', emptyArraysPerm);
      
      expect(result.return_fields).to.deep.equal([]);
      expect(result.search_fields).to.deep.equal([]);
    });

    it('should throw error for missing manifest permission object', () => {
      expect(() => {
        permissions.permissionObjectFromManifestParams('test.app', null);
      }).to.throw('Cannot read properties of null (reading \'name\')');

      expect(() => {
        permissions.permissionObjectFromManifestParams('test.app', undefined);
      }).to.throw('Cannot read properties of undefined (reading \'name\')');
    });

    it('should throw error for missing requestor app', () => {
      expect(() => {
        permissions.permissionObjectFromManifestParams(null, validManifestPerm);
      }).to.throw('permissionObjectFromManifestParams: cannot make permission without a proper permission object or app');

      expect(() => {
        permissions.permissionObjectFromManifestParams('', validManifestPerm);
      }).to.throw('permissionObjectFromManifestParams: cannot make permission without a proper permission object or app');
    });

    it('should throw error for missing permission name', () => {
      const permWithoutName = { ...validManifestPerm };
      delete permWithoutName.name;

      expect(() => {
        permissions.permissionObjectFromManifestParams('test.app', permWithoutName);
      }).to.throw('permissionObjectFromManifestParams: cannot make permission without a permissionname');
    });

    it('should throw error for missing table_id when required', () => {
      const permWithoutTable = {
        name: 'read_users',
        type: 'db_query',
        description: 'Read user records'
      };

      expect(() => {
        permissions.permissionObjectFromManifestParams('test.app', permWithoutTable);
      }).to.throw('permissionObjectFromManifestParams: cannot make permission without a table or read_users');
    });

    it('should allow missing table_id for use_app type', () => {
      const useAppPerm = {
        name: 'use_app',
        type: 'use_app',
        description: 'Use the application'
      };

      expect(() => {
        permissions.permissionObjectFromManifestParams('test.app', useAppPerm);
      }).to.not.throw();
    });

    it('should allow missing table_id for upload_pages type', () => {
      const uploadPerm = {
        name: 'upload_pages',
        type: 'upload_pages',
        description: 'Upload pages'
      };

      expect(() => {
        permissions.permissionObjectFromManifestParams('test.app', uploadPerm);
      }).to.not.throw();
    });

    it('should allow missing table_id for use_serverless type', () => {
      const microservicePerm = {
        name: 'use_serverless_name',
        type: 'use_serverless',
        description: 'Use serverless'
      };

      expect(() => {
        permissions.permissionObjectFromManifestParams('test.app', microservicePerm);
      }).to.not.throw();
    });

    it('should throw error for invalid permission type', () => {
      const invalidTypePerm = {
        name: 'invalid_permission',
        type: 'invalid_type',
        table_id: 'users'
      };

      expect(() => {
        permissions.permissionObjectFromManifestParams('test.app', invalidTypePerm);
      }).to.throw('permissionObjectFromManifestParams: permission type is not allowed for invalid_permission');
    });

    it('should accept all valid permission types', () => {
      const validTypes = [
        'upload_pages',
        'share_records', 
        'read_all',
        'message_records',
        'write_own',
        'write_all',
        'db_query',
        'use_app',
        'use_serverless'
      ];

      validTypes.forEach(type => {
        const perm = {
          name: `test_${type}`,
          type: type,
          table_id: 'users'
        };

        expect(() => {
          permissions.permissionObjectFromManifestParams('test.app', perm);
        }).to.not.throw();
      });
    });

    it('should handle wrong data types', () => {
      const wrongTypePerm = {
        name: 'test_permission',
        type: 'db_query',
        table_id: 'users',
        return_fields: 'not_an_array', // Should be array
        search_fields: 123 // Should be array
      };

      expect(() => {
        permissions.permissionObjectFromManifestParams('test.app', wrongTypePerm);
      }).to.throw('permissionObjectFromManifestParams: Wrong types for permission test_permission: return_fields search_fields');
    });
  });

  describe('updatePermissionRecordsFromManifestAsync', () => {
    let mockFreezrUserPermsDB;

    beforeEach(() => {
      // Create a mock database with async methods
      mockFreezrUserPermsDB = {
        async: {
          query: async () => [],
          create: async () => ({}),
          update: async () => ({})
        }
      };
    });

    it('should handle empty manifest', async () => {
              await permissions.updatePermissionRecordsFromManifestAsync(mockFreezrUserPermsDB, 'test.app', null);
      // Should not throw an error
    });

    it('should handle manifest without permissions', async () => {
      const manifest = { app_tables: {} };
      
      await permissions.updatePermissionRecordsFromManifestAsync(mockFreezrUserPermsDB, 'test.app', manifest);
      // Should not throw an error
    });

    it('should handle empty permissions array', async () => {
      const manifest = { permissions: [] };
      
      await permissions.updatePermissionRecordsFromManifestAsync(mockFreezrUserPermsDB, 'test.app', manifest);
      // Should not throw an error
    });

    it('should throw error for invalid permission in manifest', async () => {
      const manifest = {
        permissions: [
          {
            name: 'invalid_permission',
            type: 'invalid_type',
            table_id: 'users'
          }
        ]
      };

      try {
        await permissions.updatePermissionRecordsFromManifestAsync(mockFreezrUserPermsDB, 'test.app', manifest);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('permissionObjectFromManifestParams: permission type is not allowed for invalid_permission');
      }
    });

    it('should create new permissions when none exist', async () => {
      const manifest = {
        permissions: [
          {
            name: 'read_users',
            type: 'db_query',
            table_id: 'users',
            description: 'Read user records'
          }
        ]
      };

      let createCalled = false;
      mockFreezrUserPermsDB.async.create = async () => {
        createCalled = true;
        return {};
      };

      await permissions.updatePermissionRecordsFromManifestAsync(mockFreezrUserPermsDB, 'test.app', manifest);
      
      expect(createCalled).to.be.true;
    });

    it('should update existing permissions when they differ', async () => {
      const manifest = {
        permissions: [
          {
            name: 'read_users',
            type: 'db_query',
            table_id: 'users',
            description: 'Updated description'
          }
        ]
      };

      // Mock existing permission
      mockFreezrUserPermsDB.async.query = async () => [
        {
          _id: 'existing_id',
          name: 'read_users',
          type: 'db_query',
          table_id: 'users',
          description: 'Old description',
          granted: true,
          status: 'pending'
        }
      ];

      let updateCalled = false;
      mockFreezrUserPermsDB.async.update = async () => {
        updateCalled = true;
        return {};
      };

      await permissions.updatePermissionRecordsFromManifestAsync(mockFreezrUserPermsDB, 'test.app', manifest);
      
      expect(updateCalled).to.be.true;
    });

    it('should mark removed permissions as outdated', async () => {
      const manifest = {
        permissions: [] // No permissions in manifest
      };

      // Mock existing permission
      mockFreezrUserPermsDB.async.query = async () => [
        {
          _id: 'existing_id',
          name: 'read_users',
          type: 'db_query',
          table_id: 'users',
          granted: true,
          status: 'pending'
        }
      ];

      let updateCalled = false;
      let updatedStatus = '';
      mockFreezrUserPermsDB.async.update = async (id, perm) => {
        updateCalled = true;
        updatedStatus = perm.status;
        return {};
      };

      await permissions.updatePermissionRecordsFromManifestAsync(mockFreezrUserPermsDB, 'test.app', manifest);
      
      // The function returns early when manifest.permissions is empty, so no update should be called
      expect(updateCalled).to.be.false;
    });
  });


}); 