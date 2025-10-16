const axios = require('axios');
const { Storage } = require('@google-cloud/storage');
const { Firestore } = require('@google-cloud/firestore');

// Credit cost per 1 lead
const serviceCostPerLead = 2;
const bucketName = 'ssfs-bucket';
const serviceName = 'ssfs-ethan-oct16';

const storage = new Storage();
const firestore = new Firestore({
  projectId: 'ssfs-202408',
  databaseId: 'ssfs',
  ignoreUndefinedProperties: true
});

/**
 * Log debug messages to console if `debug_logs_on` env variable is set to true.
 */
function logDebug(message) {
  if (process.env.debug_logs_on === 'true') {
    console.log(message);
  }
}

// remote prod
const targetUrl = process.env.SSFS_SERVICE_CALLBACK_URL;

// local testing
// const targetUrl = 'http://127.0.0.1:8081/submitAsyncActionService';

// Authentication middleware
const authMiddleware = async (req, res, next) => {
  //logEntry('ssfs-202408', 'chatgpt-ssfs-logs', 'authMiddleware req.headers:' + JSON.stringify(req.headers), true);
  const authHeader = req.headers['x-api-key'];
  const { token, apiCallBackKey, campaignId, callbackUrl, context, objectData } = req.body;

  // Get Munchkin ID from context
  const munchkinId = context.subscription.munchkinId;

  const userApiKey = await getUserApiKey(munchkinId);

  if (!authHeader) {
    logDebug('Authorization header missing');
    return res.status(401).json({ error: 'Authorization header missing' });
  }
  // Perform your authentication logic here
  if (authHeader !== `${userApiKey}`) {
    logDebug('Marketo sent API key: ' + authHeader + ' , user stored API key in Firestore: ' + userApiKey);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  next();
};

exports.submitAsyncAction = async (req, res) => {
  try {

    let auth = await authMiddleware(req, res, async () => {

      const jsonData = req.body;
      
      // prod
      const { token, apiCallBackKey, campaignId, callbackUrl, context, objectData } = req.body;
      const munchkinId = context.subscription.munchkinId;

      // local testing
      // const jsonDataParsed = JSON.parse(jsonData);
      // const munchkinId = jsonDataParsed.context.subscription.munchkinId;
      // const objectData = jsonDataParsed.objectData;


      const quota = await checkQuota(munchkinId, objectData);
      logDebug(quota);

      if (!quota.allowed) {
        return res.status(403).send({
          error: quota.message
        });
      }

      const filename = `${serviceName}/${munchkinId}/data-${Date.now()}.json`;
      const file = storage.bucket(bucketName).file(filename);

      // Upload JSON data to GCS
      await file.save(JSON.stringify(jsonData));
      logDebug(`File ${filename} uploaded to ${bucketName}.`);

      // Header for internal routing to allow those requests to pass through the loadbalancer security policy in GCP
      const headers = {
        headers: {
            'internal-routing': 'ssfs-internal'
        }
      };

      // Prepare the payload for the POST request
      const payload = {
        filename: filename,
        bucketName: bucketName,
        path: `gs://${bucketName}/${filename}`
      };

      await res.status(201).send('Request accepted successfully');
      logDebug('Request accepted successfully');

      // Trigger the POST request
      logDebug(`Sending notification to ${targetUrl} with payload:`);
      logDebug(payload);
      await axios.post(targetUrl, payload, headers);
      logDebug(`Notification sent to ${targetUrl}`);

    });
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send('Internal Server Error');
  }
};

/**
 * Check quota for ZeroBounce service based on Munchkin ID and object data.
 *
 * @param {string} subscriptionId - Munchkin ID
 * @param {array} objectData - Array of objects to be processed
 * @returns {object} Quota object with allowed status and message
 */
checkQuota = async (subscriptionId, objectData) => {

  // Check if subscription ID is provided
  if (!subscriptionId) {
    return { message: 'subscriptionId is required' };
  }

  try {

    const objectCount = objectData.length;

    if (objectCount < 1) {
      logDebug({ message: 'At least one object is required', allowed: false });
      return { message: 'At least one object is required', allowed: false };
    }

    const quotaDoc = firestore.collection('subscriptions').doc(subscriptionId);
    const doc = await quotaDoc.get();

    if (!doc.exists) {
      logDebug({ message: 'ID not found', allowed: false });
      return { message: 'ID not found', allowed: false };
    }

    // Get remaining quota
    const data = doc.data();
    const creditsNeeded = objectCount * serviceCostPerLead;
    if (data.quota > creditsNeeded) {
      const updatedQuota = data.quota - creditsNeeded;
      await quotaDoc.update({ quota: updatedQuota });

      logDebug({ message: 'Success', usedQuota: creditsNeeded, remainingQuota: updatedQuota, allowed: true });
      return { message: 'Success', usedQuota: creditsNeeded, remainingQuota: updatedQuota, allowed: true };
    } else {
      logDebug({
        message: `Quota exceeded, you\'ve requested ${objectCount} leads to be processed, only ${data.quota / serviceCostPerLead} leads can be processed based on your remaining credits quota, additional subscription credits are required. Please renew your subscription.`,
        remainingQuota: data.quota,
        allowed: false
      });
      return { message: `Quota exceeded, you\'ve requested ${objectCount} leads to be processed, only ${data.quota / serviceCostPerLead} leads can be processed based on your remaining credits quota, additional subscription credits are required. Please renew your subscription.`, remainingQuota: data.quota, allowed: false };
    }
  } catch (error) {
    logDebug({ message: JSON.stringify(error), allowed: false });
    return { message: 'Internal Server Error', allowed: false };
  }
};

/**
 * Fetches the user API key for this SSFS service based on Munchkin ID.
 *
 * @param {string} subscriptionId - Munchkin ID
 * @returns {string} - The user API key for this SSFS service based on Munchkin ID
 */
getUserApiKey = async (subscriptionId) => {
  // Check if subscription ID is provided
  if (!subscriptionId) {
    return { message: 'subscriptionId is required' };
  }

  try {

    const quotaDoc = firestore.collection('subscriptions').doc(subscriptionId);
    const doc = await quotaDoc.get();

    if (!doc.exists) {
      logDebug({ message: 'ID not found', allowed: false });
      return { message: 'ID not found', allowed: false };
    }

    // Get remaining quota
    const data = doc.data();
    if (data.ssfs_account_api_key !== undefined) {
      logDebug({ message: 'Found user API key: ' + data.ssfs_account_api_key });
      return data.ssfs_account_api_key;
    } else {
      logDebug({
        message: `The user with Munchkin ID ${subscriptionId} has no API key stored in the database.`
      });
      return false;
    }
  } catch (error) {
    logDebug({ message: JSON.stringify(error) });
    return false;
  }
}