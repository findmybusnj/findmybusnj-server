// imports
const express = require('express');
const request = require('request');
const http = require('http');
const https = require('https');
const staticServe = require('serve-static');
const fs = require('fs');
const bodyParser = require('body-parser');
const xml2json = require('xml2json');
const redis = require('redis');

const redisClient = redis.createClient(6379);

// keys
const gAPIKey = require('./keys.js');

// server
const app = express();

app.use(bodyParser.json()); // used for parsing application/json
app.use(bodyParser.urlencoded({ extended: true }));     // for parsing application/x-www-form-unlencoded
app.use(staticServe('_domain', { 'index': ['index.html', 'index.html'] }));
app.set('trust proxy', true);
app.set('trust proxy', 'loopback');

const ssl = {
    key: fs.readFileSync('/etc/letsencrypt/live/findmybusnj.com/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/findmybusnj.com/fullchain.pem'),
    ca: fs.readFileSync('/etc/letsencrypt/live/findmybusnj.com/chain.pem')
}

http.createServer(app).listen(process.env.PORT || 8000);
https.createServer(ssl, app).listen(process.env.PORT || 8443);

// Helper functions //
/**
 * Gets the base url for the requests string
 * @param  String   endpoint String that decides the url to be returned
 * @return String            A string that is the url endpoint to hit
 */
function returnBaseURL(endpoint) {
    switch (endpoint) {
        case "stop":
            return 'http://mybusnow.njtransit.com/bustime/eta/getStopPredictionsETA.jsp?route=all&stop=';
        case "gAPI": {
            return 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?';
        }
        default: {
            return '';
        }
    }
};

/**
 * Sort the stops based on next 10 buses
 *
 * @param stopArray Contains all the stops to be filtered
 */
function filterFirstTenStops(stopArray) {
    const responseArray = [];

    let i = 0;
    for (i; i < stopArray.length; i += 1) {
        // only want first 10 responses
        if (i === 11) {
            return responseArray;
        }
        responseArray.push(stopArray[i]);
    }

    return responseArray;
};

/**
 * Returns the first 10 bus numbers matching the routeNumber passed in
 * @param  Array    stopArray   Array that contains current stops
 * @param  String   routeNumber String represenation of the route number
 * @return Array                Array containing all the filtered route numbers
 */
function filterFirstTenStopsForRoute(stopArray, routeNumber) {
    const responseArray = [];

    let i = 0;
    for (i; i < stopArray.length; i += 1) {
        // check to see that the routeNumbers match before adding
        if (stopArray[i].rn === routeNumber) {
            responseArray.push(stopArray[i]);
        }
        // Return once we get to 10 in case we have more than 10
        if (responseArray.length === 10) {
            return responseArray;
        }
    }

    return responseArray
};

/**
 * Gets the data from Redis if the result exists
 * @param  {Error}    err   The error if there exists one
 * @param  {JSON}     reply The json reply from the server
 * @return json           The result from the Redis database, or "No Current Prediction" if none exists
 */
function resultExists(err, reply) {
    // Check DB to see if we have a recent record
    redisClient.exists(stop, (err, reply) => {
        // Return if we do
        if (reply) {
            redisClient.get(stop, (err, reply) => {
                res.json(JSON.parse(reply));
            });
        }
        // Give no prediction if we don't
        else {
            res.json("No Current Predictions");
        }
    });
}

// Routes and endpoints //
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
app.post('/rest/stop', (req, res) => {
    /**
     * put the stop in json form
     * NOTE: The stop double as the key
     */
    const stop = req.body.stop;
    const baseURL = returnBaseURL("stop");
    const requestURL = baseURL + stop;

    request({ url: requestURL }, (error, response, body) => {
        const options = {
            object: true    // converts response to JS object
        };

        if (!error && response.statusCode === 200) {
            const busesObject = xml2json.toJson(body, options);
            const busesArray = busesObject.stop.pre;  // if NJT changes their xml format, this will break
            const noPrediction = busesObject.stop.noPredictionMessage;

            if (noPrediction) {
                // We have no current predictions
                redisClient.set(stop, "No arrival times");
                res.json(noPrediction);
                return;
            }

            if (busesArray instanceof Array) {
                const filteredArray = filterFirstTenStops(busesArray);
                redisClient.set(stop, JSON.stringify(filteredArray));   // put the most recent response in the DB incase we can't reach NJT
                res.json(filteredArray);
            }
            else {
                // We only have one object
                const singleObject = [];
                singleObject.push(busesArray);
                redisClient.set(stop, JSON.stringify(singleObject));
                res.json(singleObject);
            }
        }
        else {
            resultExists(err, reply);
        }
    });
});

/**
 * Gets the next stops that contain the bus being requested
 * @param  form-data req    request data being sent to the endpoint
 * @param  json      res    result being handed back to the user
 * @return JSON      res    result items in json form sent back to the user
 */
app.post('/rest/stop/byRoute', (req, res) => {
    const stop = req.body.stop;
    const route = req.body.route;
    const baseURL = returnBaseURL("stop");
    const requestURL = baseURL + stop;
    // NOTE: Key consists of the stop and the route as one number, which fairly unique.
    const key = stop + route;

    request({ url: requestURL }, (error, response, body) => {
        const options = {
            object: true    // converts response to JS object
        };

        if (!error && response.statusCode === 200) {
            const busesObject = xml2json.toJson(body, options);
            const busesArray = busesObject.stop.pre;  // if NJT changes their xml format, this will break
            const noPrediction = busesObject.stop.noPredictionMessage;

            if (noPrediction) {
                // We have no current predictions
                redisClient.set(key, "No arrival times");
                res.json(noPrediction);
                return;
            }

            if (busesArray instanceof Array) {
                const filteredArray = filterFirstTenStopsForRoute(busesArray, route);
                redisClient.set(key, JSON.stringify(filteredArray));   // put the most recent response in the DB incase we can't reach NJT
                res.json(filteredArray);
            }
            else {
                // We only have one object
                const singleObject = [];
                singleObject.push(busesArray);
                redisClient.set(stop, JSON.stringify(singleObject));
                res.json(singleObject);
            }
        }
        else {
            resultExists(err, reply);
        }
    });
});

/**
 * Gets the nearby stops from google maps api
 * @param  form-data req      request data to be sent to google
 * @param  json      res      result being handed back to the user
 * @return JSON      res      result item is resturned to the user
 */
app.post('/rest/getPlaces', (req, res) => {
    const reqBody = req.body;

    // Define base URL and addition appended strings
    const baseURL = returnBaseURL("gAPI");
    const location = `location=${  reqBody.latitude  },${  reqBody.longitude  }&`;
    const radius = `radius=${  reqBody.radius  }&`;
    const types = `types=${  reqBody.types  }&`;

    const placesUrl = baseURL + location + radius + types + gAPIKey;
    // console.log(placesUrl);
    request({ url: placesUrl, json: true },
        (error, response, body) => {
            if (!error && response.statusCode === 200) {
                res.json(body);
            }
        });
});
