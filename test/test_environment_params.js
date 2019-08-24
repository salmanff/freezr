
// A set of environment params

exports.params= [
      {
          test_name:"Local Mongo",
          test_description:"Standard environment with local fs and mongo",
          port:3000,
          dbParams:{
              port:"27017",
              host:"localhost",
              pass:null,
              user:null,
              addAuth:false,
              unifiedDbName:null
          },
          userDirParams:{},
          freezr_is_setup:true,
          first_user:"test_user",
      },

      {
          "test_name":"Local nedb",
          "test_description":"using nedb as a database",
          "port":3000,
          "dbParams":{
              dbtype:"nedb",
              db_path : "testNedb",
          },
          userDirParams:{
            userRoot:".data"
          },
          "freezr_is_setup":true,
          "first_user":"test_user",
      }

]

const other_tests = [
  // Use this if you have already generated a GAE key file
  {
      "test_name":"GAE Cloud Datastore",
      "test_description":"Google App Engine",
      dbParams:{
          dbtype:"gaeCloudDatastore",
          gaeKeyFile:false,
          projectid:null
      },
      "freezr_is_setup":true,
      "first_user":"test_user",
  }

]
