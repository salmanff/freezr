
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
          fsParams:{},
          freezrIsSetup:true,
          firstUser:"test_user",
      },

      {
          "test_name":"Local nedb",
          "test_description":"using nedb as a database",
          "port":3000,
          "dbParams":{
              dbtype:"nedb",
              db_path : "testNedb",
          },
          fsParams:{
            userRoot:".data"
          },
          "freezrIsSetup":true,
          "firstUser":"test_user",
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
      "freezrIsSetup":true,
      "firstUser":"test_user",
  }

]
