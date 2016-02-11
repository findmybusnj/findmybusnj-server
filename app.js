// imports
var express = require('express');
var request = require('request');
var http = require('http');
var https = require('https');
var staticServe = require('serve-static');
var fs = require('fs');
var bodyParser = require('body-parser');
var xml2json = require('xml2json');
var redis = require('redis');
var redisClient = redis.createClient(6379);

// server
var app = express();

app.use(bodyParser.json());	// used for parsing application/json
app.use(bodyParser.urlencoded({ extended: true })); 	// for parsing application/x-www-form-unlencoded
app.use(staticServe('_domain', {'index': ['index.html', 'index.html']}));
app.set('trust proxy', true);
app.set('trust proxy', 'loopback');

var ssl = {
	key: fs.readFileSync('/etc/letsencrypt/live/findmybusnj.com/privkey.pem'),
	cert: fs.readFileSync('/etc/letsencrypt/live/findmybusnj.com/fullchain.pem'),
	ca: fs.readFileSync('/etc/letsencrypt/live/findmybusnj.com/chain.pem')
}

http.createServer(app).listen(process.env.PORT || 8000);
https.createServer(ssl, app).listen(process.env.PORT || 8443);

// Helper functions
/**
 * Sort the stops based on next 10 buses
 *
 * @param stopArray Contains all the stops to be filtered
 */
function filterFirstTenStops(stopArray) {
    var responseArray = [];

    var i = 0;
    for (i; i < 10; i++) {
        if (i > stopArray.length) {
            return responseArray;
        }
        else {
            responseArray[i] = stopArray[i];
        }
    }

    return responseArray;
};

// Routes and endpoints
/**
 * Create a function that returns the top ten pieces of data for a given
 * stop key
 *
 * use xml2json module to convert the xml for each to a JSON object that is then returned.
 * format of javascript object will be:
 *  {
        "pt": "3",          --> time till arrival
        "pu": "MINUTES",    --> minutes/arriving/delayed
        "fd": "108 NEWARK", --> Route the bus is taking, including T/R/Q/P etc.
        "v": "6373",        --> Bus number
        "rn": "108",        --> Route number, not including the letter if T/R/Q/P
        "rd": "108",
        "zone": {}
    }
 */
app.post('/rest/stop', function (req, res) {
    // put the stop in json form
    var stop = req.body.stop;
    var baseURL = "http://mybusnow.njtransit.com/bustime/eta/getStopPredictionsETA.jsp?route=all&stop="
    var requestURL = baseURL + stop;
    request({url: requestURL}, function(error, response, body) {
        var options = {
            object: true    // converts response to JS object
        };
	if (!error && response.statusCode == 200) {
            var busesObject = xml2json.toJson(body, options);
            var busesArray = busesObject.stop.pre;  // if NJT changes their xml format, this will break
	   var noPrediction = busesObject.stop.noPredictionMessage;
	   if (noPrediction) {
		// We have no current predictions
		redisClient.set(stop, "No arrival times");
		res.json(noPrediction);
		return;
	   }

	   if (busesArray instanceof Array) {
	    	var filteredArray = filterFirstTenStops(busesArray);
            	redisClient.set(stop, JSON.stringify(filteredArray));   // put the most recent response in the DB incase we can't reach NJT
	        res.json(filteredArray);
            }
	    else {
		// We only have one object
		redisClient.set(stop, JSON.stringify(busesArray));
	    	res.json(busesArray);
	    }
        }
        else {
            // Check DB to see if we have a recent record
            redisClient.exists(stop, function(err, reply) {
                // Return if we do
                if (reply) {
                    redisClient.get(stop, function(err, reply){
                        res.json(JSON.parse(reply));
                    });
                }
                // Give no prediction if we don't
                else {
                    res.json("No Current Predictions");
                }
            });
        }
    });
});

/**
 * Gets the nearby stops from google maps api
 * @param  form-data req      request data to be sent to google
 * @param  json      res      result being handed back to the user
 * @return JSON      res      result item is resturned to the user
 */
app.post('/rest/getPlaces', function (req, res) {
    var reqBody = req.body;
    var gAPIKey = 'key=AIzaSyB5pvxDYulLut0SLlHUep33ufjJ7OxUQ5M';
    
    // Define base URL and addition appended strings
    var baseURL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?';
    var location = 'location=' + reqBody.latitude + ',' + reqBody.longitude + '&';
    var radius = 'radius=' + reqBody.radius + '&';
    var types = 'types=' + reqBody.types + '&';

    var placesUrl = baseURL + location + radius + types + gAPIKey;
    console.log(placesUrl);
    request({url: placesUrl, json: true},
    function (error, response, body) {
        if (!error && response.statusCode == 200) {
            res.json(body);
        }
    });
});
