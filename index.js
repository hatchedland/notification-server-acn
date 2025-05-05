const express = require('express');
const admin = require('firebase-admin');

const app = express();
const port = 3000;


const serviceAccountKey = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountKey)
});

const db = admin.firestore();

const sendNotificationToAgent = async (cpId, title, body, data) => {
  try {
    // Get the agent's FCM token from Firestore
    const agentRef = db.collection('agents').doc(cpId);
    const agentDoc = await agentRef.get();

    if (!agentDoc.exists) {
      console.log(`Agent ${cpId} not found`);
      return { success: false, message: `Agent ${cpId} not found` };
    }

    const agentData = agentDoc.data();
    const fcmToken = agentData.fcmToken; // Assuming the token is stored in 'fcmToken' field

    if (!fcmToken) {
      console.log(`Agent ${cpId} has no FCM token`);
      return { success: false, message: `Agent ${cpId} has no FCM token` };
    }

    // Construct the message
    const message = {
      notification: {
        title: title,
        body: body
      },
      data: data,
      token: fcmToken
    };

    // Send the message
    const response = await admin.messaging().send(message);
    console.log('Successfully sent message:', response);
    return { success: true, message: 'Successfully sent message', response: response };
  } catch (error) {
    console.error('Error sending message:', error);
    return { success: false, message: 'Error sending message', error: error };
  }
};

app.post('/enquiries/:id', async (req, res) => {
  console.log('triggered')
  const enquiryId = req.params.id;

  try {
    // Fetch the enquiry data from Firestore using the enquiryId
    const enquiryRef = db.collection('enquiries').doc(enquiryId);
    const enquiryDoc = await enquiryRef.get();

    if (!enquiryDoc.exists) {
      console.log(`Enquiry ${enquiryId} not found`);
      return res.status(404).send('Enquiry not found');
    }

    const enquiryData = enquiryDoc.data();

    // Send to the person who sent the enquiry
    const results1 = await sendNotificationToAgent(
      enquiryData.cpId,
      `Enquiry Sent to Agent!`,
      `You’ve enquired about ${enquiryData.propertyId}. Check “My Enquiries” to track status.`,
      { additionalData: "optional-value" }
    );
    console.log("Notification results (buyer):", results1);

    // First query to get property details
    const propertyId = enquiryData.propertyId;
    const propertyQuerySnapshot = await db.collection("ACN123").where("propertyId", "==", propertyId).get();

    let sellerAgentCpId, propertyName;

    if (!propertyQuerySnapshot.empty) {
      propertyQuerySnapshot.forEach(doc => {
        const docData = doc.data();
        sellerAgentCpId = docData.cpCode;
        propertyName = docData.nameOfTheProperty;
      });
    }

    let buyerAgentName = 'Someone';
    // Second query to get agent details
    const agentQuerySnapshot = await db.collection("agents").where("cpId", "==", enquiryData.cpId).get();
    if (!agentQuerySnapshot.empty) {
      agentQuerySnapshot.forEach(doc => {
        const docData = doc.data();
        buyerAgentName = docData.name;
      });
    }

    if (sellerAgentCpId && propertyName) {
      const results2 = await sendNotificationToAgent(
        sellerAgentCpId,
        `New Enquiry Received!`,
        `${buyerAgentName} enquired about ${propertyName} ${enquiryData.propertyId}.`,
        { additionalData: "optional-value" }
      );
      console.log("Notification results (seller):", results2);
    } else {
      console.warn(`Property not found for enquiry ${enquiryData.propertyId}`);
    }

    res.status(200).send('Enquiry processed successfully');
  } catch (error) {
    console.error("Error executing campaign:", error);
    res.status(500).send('Error processing enquiry');
  }
});

app.get('/enquiries/:id', (req, res) => {
  const enquiryId = req.params.id;
  res.send(`Enquiry ${enquiryId} details`);
});
app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});