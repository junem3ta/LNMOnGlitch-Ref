/*C2B Backend Server*/
const prettyjson = require('prettyjson');
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require("mongoose");
const mongo = require("mongodb");
const https = require("https");
const Utils = require("./Utils.js");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));

/*Allow cross origin requests*/
app.use(function(req,res,next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

/* AppUI Setup */
/** 1. Serve main HTML file */
app.get("/", function(req, res) {
  res.sendFile(__dirname + "/views/index.html");
});

/** 2. Serve static assets  */
app.use(express.static(__dirname + "/public"));
/* Preserve code above this comment */
let localCache = [];
/*
  @HelperFn updateLocalCache(requestId, status)
  ** Update LocalCache For DOM References & MongoDB Collection updates. Used to update localcache entries with
  the callBackURL results.
  * A corresponding entry is added to a transactionDB for each Object updated in this localCache.
  * For efficiency, the Object referring to a transaction is deleted from the LocalCache at the end of the TransactionCycle.
  *The localcache has an object entry - {"requestId": "", "status": ""}  - for each transaction that ...
  * ...is updated when the /process endpoint is invoked.
  *Update the localCache entry for a specific json object and set status to either Completed | Cancelled | Failed
*/
function updateLocalCache(requestID, status) {
  for(let entry of localCache) {
    if(entry.requestID == requestID) {
      entry.status = status;
      entry.callBackStatus = true;
      entry.timeStamp = Utils.getTimeStamp();
      console.log(`LocalCache Update ${JSON.stringify(localCache)} @Test2[From CallBackURL]`);
      return entry;
    }
  }
}
/*The /process Transaction is to be finished in ~54s.
 **This fn will update the db collection for transactions with unresolved callBacks. We can call this fn 
   10s after transaction Completion [60s] making the flushAndUpdate independent of endpoint traffic, rather 
   than the original idea of having the flushAndUpdateDB() fn called for each transaction.
 **With increased user traffic, the localCache can grow to a considerable size in a short span of time. By including 
   the flushAndUpdateDB() fn, we empty the untracked transactions in our localCache into our db. 
   This prevents the localCache from building up to undesirable sizes.
 */
function flushAndUpdate() {
  if(localCache.length>0) {
    localCache.filter((entry)=> {
      if(!(entry.callBackStatus)) {
        let data = entry;
        data.resultCode = "Unkown";
        data.status = "Unresolved";
        data.resultDesc = "[Error] Unresolved Callback";

        mongo.connect(process.env.MONGO_URI, {useNewUrlParser: true}, (err,db)=>{
          if(err) {
            console.log("DBConnectionERR " + err);
            process.exit(0);
          }
          let db0 = db.db(process.env.DB);
          let collection = db0.collection(process.env.COLLECTION);
          collection.insertOne(data, (err, result) => {
            if(err) {
              console.log(`@Flush&UpdateInsertErr: ${err}`);
              process.exit(0);
            }
          });
        });
      };
      //The filter fn Deletes entries where callBackStatus == false;
      return entry.callBackStatus == true;
    });
  }
}
//Custom code here
app.post("/process", function(req,res) {
  /*Obtain request payload from app UI*/
  let amount = req.body.amnt;
  let mssidn = req.body.number;
  /*End*/
  /*Validate request body params*/
  let regExPattern = /^(?:254|\+254|0)?(7(?:(?:[129][0-9])|(?:0[0-8])|(4[0-1]))[0-9]{6})$/;
  let isNumberValid = regExPattern.test(mssidn);
  if(amount.length ==0 || isNaN(amount) || amount==0) {
    res.status(400).json({"status":"amntErr",description:"Bad Request"});
    return;
  }
  if(!isNumberValid) {
    res.status(400).json({"status":"mssidnErr",description:"Bad Request"});
    return;
  }
  /*End validation*/
  let msg = {"status": "","requestID": ""}
  let postRes = Utils.processRequest(amount, mssidn);
  postRes.then(function(rObj) {
    console.log(rObj);
    if(typeof(rObj.ResponseCode)!== "undefined" && 
       rObj.ResponseCode == "0") {
      let requestID = rObj.MerchantRequestID;
      let cacheUpdate = {
        "requestID":requestID,
        "mssidn":mssidn,
        "amount":amount,
        "callBackStatus":false,
        "status":"PendingCompletion"
      }

      localCache.push(cacheUpdate); 
      console.log(localCache);
      
      msg.status="success";
      msg.requestID=rObj.MerchantRequestID;
      res.json(msg);

      setTimeout(function() {
        flushAndUpdate();
      }, 60000);

    } else { 
      msg.status="error"
      res.json(msg);
    }
  });
});

app.post("/hooks/lnmResponse", function(req,res) {
  let requestID = req.body.Body.stkCallback.MerchantRequestID;
  let transData;
  let resultCode = req.body.Body.stkCallback.ResultCode;
  let status = resultCode == "1031" ? "Cancelled" : (
    resultCode == "1037" ? "RequestTimeOut" : (
      resultCode == "0" ? "Success" : "Failed"));

  let resultDesc = req.body.Body.stkCallback.ResultDesc;
  transData = updateLocalCache(requestID, status);
  transData.resultCode = resultCode;
  transData.resultDesc = resultDesc;

  /*Persist Processing Results to a MongoDB collection*/
  mongo.connect(process.env.MONGO_URI, 
               {useNewUrlParser: true,useUnifiedTopology: true}, (err, db) => {
    if(err) {      
      console.log(err);
      process.exit(0);
    }
    let db0 = db.db("LNMDB");
    let collection = db0.collection("LNMTransactions");
    collection.insertOne(transData, (err, result) => {
      if(err) {
        console.log(err);
        process.exit(0);
      }
      console.log("DBInsertOperation Ok")
    });
  });
  /*Send ACK receipt back to the LNM API*/  
  let message = {"ResponseCode": "0", "ResponseDesc": "success"};
  res.json(message);
});
/*LocalCache Listener for Updating appUI*/
app.post("/listener", function(req,res) {
  console.log(JSON.stringify(req.body));
  let requestID = req.body.requestID;
  for(let entry of localCache) {
    if(entry.requestID == requestID) {
      if(entry.callBackStatus) {
        res.json(entry);
        //remove the transactionObject because as it's been resolved
        localCache = localCache.filter((entry)=>{
          return entry.requestID != requestID;
        });
      } else {
        //return entry only
        res.json(entry);
      }
    }
  }
});
/*Preserve code below this comment*/
/*Listener*/
const listener = app.listen(process.env.PORT, function() {
  console.log('Your app is listening on port ' + listener.address().port);
});
