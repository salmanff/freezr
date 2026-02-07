// Unit tests for config.mjs
import { expect } from 'chai';
import {
  RESERVED_FIELD_LIST,
  RESERVED_IDS,
  MAX_USER_NAME_LEN,
  SYSTEM_APPS,
  isSystemApp,
  validAppName,
  userIdIsValid,
  userIdFromUserInput,
  validFilename,
  validDirName,
  validPermissionName,
  validCollectionName,
  tempAppNameFromFileName,
  constructAppIdStringFrom
} from '../../../../common/helpers/config.mjs';
import { describe, it, beforeEach, afterEach } from 'mocha';
import * as mocks from '../../../utils/mocks.mjs';

describe('Config Module - Constants', () => {
  describe('RESERVED_FIELD_LIST', () => {
    it('should contain expected reserved fields', () => {
      expect(RESERVED_FIELD_LIST).to.be.an('array');
      expect(RESERVED_FIELD_LIST).to.include('_id');
      expect(RESERVED_FIELD_LIST).to.include('_date_created');
      expect(RESERVED_FIELD_LIST).to.include('_date_modified');
      expect(RESERVED_FIELD_LIST).to.include('_accessible');
      expect(RESERVED_FIELD_LIST).to.include('_publicid');
      expect(RESERVED_FIELD_LIST).to.include('_date_accessibility_mod');
    });
  });

  describe('RESERVED_IDS', () => {
    it('should contain expected reserved user IDs', () => {
      expect(RESERVED_IDS).to.be.an('array');
      expect(RESERVED_IDS).to.include('fradmin');
      expect(RESERVED_IDS).to.include('admin');
      expect(RESERVED_IDS).to.include('public');
      expect(RESERVED_IDS).to.include('test');
      expect(RESERVED_IDS).to.include('freezr');
      expect(RESERVED_IDS).to.include('freezrdb');
    });
  });

  describe('MAX_USER_NAME_LEN', () => {
    it('should be a positive number', () => {
      expect(MAX_USER_NAME_LEN).to.be.a('number');
      expect(MAX_USER_NAME_LEN).to.be.greaterThan(0);
      expect(MAX_USER_NAME_LEN).to.equal(25);
    });
  });

  describe('SYSTEM_APPS', () => {
    it('should contain expected system apps', () => {
      expect(SYSTEM_APPS).to.be.an('array');
      expect(SYSTEM_APPS).to.include('info.freezr');
      expect(SYSTEM_APPS).to.include('dev.ceps');
    });
  });
});

describe('Config Module - Validation Functions', () => {
  describe('isSystemApp', () => {
    it('should return true for system apps', () => {
      expect(isSystemApp('info.freezr.account')).to.be.true;
      expect(isSystemApp('info.freezr.admin')).to.be.true;
      expect(isSystemApp('dev.ceps.test')).to.be.true;
    });

    it('should return false for non-system apps', () => {
      expect(isSystemApp('myapp.test.user')).to.be.false;
      expect(isSystemApp('com.example.app')).to.be.false;
      expect(isSystemApp('')).to.be.false;
      expect(isSystemApp(null)).to.be.false;
      expect(isSystemApp(undefined)).to.be.false;
    });
  });

  describe('validAppName', () => {
    it('should return true for valid app names', () => {
      expect(validAppName('com.example.app')).to.be.true;
      expect(validAppName('org.test.app')).to.be.true;
      expect(validAppName('net.myapp.test')).to.be.true;
    });

    it('should return false for invalid app names', () => {
      // Too short (less than 3 segments)
      expect(validAppName('app')).to.be.false;
      expect(validAppName('com.app')).to.be.false;
      
      // Contains invalid characters
      expect(validAppName('com.app_test')).to.be.false;
      expect(validAppName('com.app test')).to.be.false;
      expect(validAppName('com.app$test')).to.be.false;
      expect(validAppName('com.app"test')).to.be.false;
      expect(validAppName('com.app/test')).to.be.false;
      expect(validAppName('com.app@test')).to.be.false;
      expect(validAppName('com.app\\test')).to.be.false;
      expect(validAppName('com.app{test')).to.be.false;
      expect(validAppName('com.app}test')).to.be.false;
      expect(validAppName('com.app..test')).to.be.false;
      
      // Starts with invalid prefixes
      expect(validAppName('.com.app.test')).to.be.false;
      expect(validAppName('-com.app.test')).to.be.false;
      expect(validAppName('\\com.app.test')).to.be.false;
      expect(validAppName('system.app.test')).to.be.false;
      
      // System apps
      expect(validAppName('info.freezr.account')).to.be.false;
      
      // Invalid inputs
      expect(validAppName('')).to.be.false;
      expect(validAppName(null)).to.be.false;
      expect(validAppName(undefined)).to.be.false;
    });

    it('should handle length limits', () => {
      const longName = 'a'.repeat(MAX_USER_NAME_LEN + 1);
      expect(validAppName(longName)).to.be.false;
    });
  });

  describe('userIdIsValid', () => {
    it('should return true for valid user IDs', () => {
      expect(userIdIsValid('john')).to.be.true;
      expect(userIdIsValid('jane123')).to.be.true;
      expect(userIdIsValid('user-name')).to.be.true;
    });

    it('should return false for invalid user IDs', () => {
      // Reserved IDs
      expect(userIdIsValid('admin')).to.be.false;
      expect(userIdIsValid('fradmin')).to.be.false;
      expect(userIdIsValid('public')).to.be.false;
      expect(userIdIsValid('test')).to.be.false;
      expect(userIdIsValid('freezr')).to.be.false;
      expect(userIdIsValid('freezrdb')).to.be.false;
      
      // Starts with freezr
      expect(userIdIsValid('freezruser')).to.be.false;
      
      // Contains invalid characters
      expect(userIdIsValid('user@domain')).to.be.false;
      expect(userIdIsValid('user_name')).to.be.false;
      expect(userIdIsValid('user name')).to.be.false;
      expect(userIdIsValid('user/name')).to.be.false;
      expect(userIdIsValid('user{name')).to.be.false;
      expect(userIdIsValid('user}name')).to.be.false;
      expect(userIdIsValid('user(name')).to.be.false;
      expect(userIdIsValid('user)name')).to.be.false;
      expect(userIdIsValid('user"name')).to.be.false;
      expect(userIdIsValid("user'name")).to.be.false;
      
      // Too long
      const longId = 'a'.repeat(MAX_USER_NAME_LEN + 1);
      expect(userIdIsValid(longId)).to.be.false;
    });

    it('should handle URL encoding', () => {
      expect(userIdIsValid('user%20name')).to.be.false; // URL encoded space
    });
  });

  describe('userIdFromUserInput', () => {
    it('should normalize user input correctly', () => {
      expect(userIdFromUserInput('John Doe')).to.equal('john_doe');
      expect(userIdFromUserInput('  Jane Smith  ')).to.equal('jane_smith');
      expect(userIdFromUserInput('USER123')).to.equal('user123');
      expect(userIdFromUserInput('')).to.be.null;
      expect(userIdFromUserInput(null)).to.be.null;
      expect(userIdFromUserInput(undefined)).to.be.null;
    });

    it('should handle URL encoding', () => {
      expect(userIdFromUserInput('user%20name')).to.equal('user name');
    });
  });

  describe('validFilename', () => {
    it('should return true for valid filenames', () => {
      expect(validFilename('file.txt')).to.be.true;
      expect(validFilename('file-name.txt')).to.be.true;
      expect(validFilename('file_name.txt')).to.be.true;
      expect(validFilename('file123.txt')).to.be.true;
      expect(validFilename('file name.txt')).to.be.true;
    });

    it('should return false for invalid filenames', () => {
      expect(validFilename('')).to.be.false;
      expect(validFilename(null)).to.be.false;
      expect(validFilename(undefined)).to.be.false;
      expect(validFilename('file<>.txt')).to.be.false;
      expect(validFilename('file|.txt')).to.be.false;
      expect(validFilename('file:.txt')).to.be.false;
    });
  });

  describe('validDirName', () => {
    it('should return true for valid directory names', () => {
      expect(validDirName('dirname')).to.be.true;
      expect(validDirName('dir-name')).to.be.true;
      expect(validDirName('dir_name')).to.be.true;
      expect(validDirName('dir123')).to.be.true;
      expect(validDirName('dir.name')).to.be.true;
    });

    it('should return false for invalid directory names', () => {
      expect(validDirName('')).to.be.false;
      expect(validDirName(null)).to.be.false;
      expect(validDirName(undefined)).to.be.false;
      expect(validDirName('dir name')).to.be.false;
      expect(validDirName('dir/name')).to.be.false;
    });
  });

  describe('validPermissionName', () => {
    it('should return true for valid permission names', () => {
      expect(validPermissionName('read')).to.be.true;
      expect(validPermissionName('write')).to.be.true;
      expect(validPermissionName('delete')).to.be.true;
    });

    it('should return false for invalid permission names', () => {
      expect(validPermissionName('read write')).to.be.false;
      expect(validPermissionName('read/write')).to.be.false;
    });
  });

  describe('validCollectionName', () => {
    it('should return true for valid collection names', () => {
      expect(validCollectionName('users')).to.be.true;
      expect(validCollectionName('posts')).to.be.true;
      expect(validCollectionName('')).to.be.true; // Empty is allowed
      expect(validCollectionName(null)).to.be.true; // Null is allowed
    });

    it('should return false for invalid collection names', () => {
      expect(validCollectionName('user_posts')).to.be.false;
      expect(validCollectionName('user/posts')).to.be.false;
      expect(validCollectionName('user posts')).to.be.false;
      expect(validCollectionName('user@posts')).to.be.false;
      expect(validCollectionName('.users')).to.be.false;
      expect(validCollectionName('-users')).to.be.false;
      expect(validCollectionName('\\users')).to.be.false;
      expect(validCollectionName('field_permissions')).to.be.false; // Reserved
      expect(validCollectionName('accessible_objects')).to.be.false; // Reserved
    });
  });
});

describe('Config Module - Utility Functions', () => {
  describe('tempAppNameFromFileName', () => {
    it('should extract app name from filename', () => {
      expect(tempAppNameFromFileName('myapp.zip')).to.equal('myapp');
      expect(tempAppNameFromFileName('myapp-main.zip')).to.equal('mya');
      expect(tempAppNameFromFileName('myapp.app')).to.equal('myapp');
      expect(tempAppNameFromFileName('myapp-main.app')).to.equal('mya');
    });

    it('should handle complex filenames', () => {
      expect(tempAppNameFromFileName('myapp version 1.0.zip')).to.equal('myapp');
      expect(tempAppNameFromFileName('myapp-main version 1.0.zip')).to.equal('myapp-main');
    });
  });

  describe('constructAppIdStringFrom', () => {
    it('should create app ID correctly', () => {
      expect(constructAppIdStringFrom('user1', 'myapp')).to.equal('user1_myapp');
      expect(constructAppIdStringFrom('john', 'testapp')).to.equal('john_testapp');
    });
  });
});

 