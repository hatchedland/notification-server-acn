const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

const app = express();
app.use(cors());
const port = 3000;

const serviceAccountKey = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountKey),
});

const db = admin.firestore();

const sendNotificationToAgent = async (cpId, title, body, data) => {
  try {
    // Get the agent's FCM token from Firestore
    const agentRef = db.collection("agents").doc(cpId);
    const agentDoc = await agentRef.get();

    if (!agentDoc.exists) {
      console.log(`Agent ${cpId} not found`);
      return { success: false, message: `Agent ${cpId} not found` };
    } else {
      console.log(`Agent ${cpId} found`);
    }

    const agentData = agentDoc.data();
    const isArray = Array.isArray(agentData.fsmToken);
    const tokens = isArray ? agentData.fsmToken : [agentData.fsmToken];

    if (tokens.length === 0) {
      console.log(`⚠ Agent ${cpId} has empty fsmToken array`);
    }

    // Create the message object
    const message = {
      notification: { title, body },
    };

    // Add data payload if provided
    if (Object.keys(data).length > 0) {
      message.data = data;
    }

    // Track successful sends
    let successCount = 0;

    // Send notification to each token for this agent
    for (const token of tokens) {
      try {
        // Add token to the message
        message.token = token;

        // Send the notification
        const res = await admin.messaging().send(message);
        console.log(
          `✅ Sent to ${cpId} (token: ${token.slice(0, 8)}...): ${res}`
        );
        successCount++;
      } catch (err) {
        const code = err.code || "";
        const bad =
          code.includes("not-registered") ||
          code.includes("invalid-registration-token");

        if (bad) {
          // Handle token removal based on storage type
          if (isArray) {
            await agentDoc.ref.update({
              fsmToken: admin.firestore.FieldValue.arrayRemove(token),
            });
            console.log(
              `🗑 Removed expired token ${token.slice(
                0,
                8
              )}... from agent ${cpId}`
            );
          } else {
            await agentDoc.ref.update({
              fsmToken: admin.firestore.FieldValue.delete(),
            });
            console.log(`🗑 Deleted fsmToken field from agent ${cpId}`);
          }
        } else {
          console.log(
            `⚠ Failed to send to ${cpId} (token: ${token.slice(
              0,
              8
            )}...) — ${code}: ${err.message}`
          );
        }
      }
    }
  } catch (err) {
    console.error(`❌ Error processing notification for agent ${cpId}:`, err);
  }
};

app.post("/property/:id", async (req, res) => {
  const propertyId = req.params.id;
  console.log(propertyId);
  try {
    const propertyRef = db.collection("ACN123").doc(propertyId);
    const propertyDoc = await propertyRef.get();

    if (!propertyDoc.exists) {
      return res.status(404).send("Property Not Found");
    }

    const propertyData = propertyDoc.data();

    await sendNotificationToAgent(
      propertyData.cpCode,
      `Listing Live!`,
      `Your listing for ${propertyData.nameOfTheProperty} is now live ${propertyData.propertyId}.`,
      { additionalData: "optional-value" }
    );
    res.status(200).send("Enquiry processed successfully");
  } catch {
    console.error("Error");
    res.status(500).send("Error sending notification");
  }
});

app.post("/qcstatus/:id", async (req, res) => {
  const qcId = req.params.id;
  console.log("inside qcStatus", qcId);
  try {
    const qcRef = db.collection("QC_Inventories").doc(qcId);
    console.log(qcRef, "qcRef");
    const qcDoc = await qcRef.get();
    console.log(qcDoc, "qcDoc");
    if (!qcDoc.exists) {
      console.log("Document Not Found!");
      return res.status(404).send("Property Not Found");
    }
    const qcData = qcDoc.data();

    console.log(qcData, "qcData");

    let title, body;
    if (qcData.qcStatus === "available") return res(200).send("Listed! Sending Notfication with property Id.")

    switch (qcData.qcStatus) {
      case "duplicate":
        title = "Duplicate Listing Detected";
        body = `This unit in ${qcData.nameOfTheProperty} is already listed by another agent`;
        break;
      case "primary":
        title = "Primary Property Detected";
        body = `ACN only lists resale inventories. If this is an error, contact KAM.`;
        break;
      case "rejected":
        title = "Listing Rejected";
        body = `Your listing for ${qcData.nameOfTheProperty} was rejected.`; // Fixed typo: "rejecte" -> "rejected"
        break;
      case "pending":
        title = "Duplicate Listing Detected";
        body = `This unit in ${qcData.nameOfTheProperty} is already listed by another agent`;
        break;
      default:
        title = "Listing Submitted!";
        body = `Your listing for ${qcData.nameOfTheProperty} is under review.`;
        break; // Added break statement for default case (optional but good practice)
    }
    console.log(title, "title\n", body, "body");

    await sendNotificationToAgent(qcData.cpCode, title, body, {
      additionalData: "optional-value",
    });
    res.status(200).send("Successfully Sent Notification");
  } catch {
    res.status(500).send("Error sending notification");
  }
});

app.post("/enquiries/:id", async (req, res) => {
  const enquiryId = req.params.id;

  try {
    // Fetch the enquiry data from Firestore using the enquiryId
    const enquiryRef = db.collection("enquiries").doc(enquiryId);
    const enquiryDoc = await enquiryRef.get();

    if (!enquiryDoc.exists) {
      console.log(`Enquiry ${enquiryId} not found`);
      return res.status(404).send("Enquiry not found");
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
    const propertyQuerySnapshot = await db
      .collection("ACN123")
      .where("propertyId", "==", propertyId)
      .get();

    let sellerAgentCpId, propertyName, buyerAgentName;

    if (!propertyQuerySnapshot.empty) {
      propertyQuerySnapshot.forEach((doc) => {
        const docData = doc.data();
        sellerAgentCpId = docData.cpCode;
        propertyName = docData.nameOfTheProperty;
      });
    }

    // Second query to get agent details
    const agentQuerySnapshot = await db
      .collection("agents")
      .where("cpId", "==", enquiryData.cpId)
      .get();
    if (!agentQuerySnapshot.empty) {
      agentQuerySnapshot.forEach((doc) => {
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

    res.status(200).send("Enquiry processed successfully");
  } catch (error) {
    console.error("Error executing campaign:", error);
    res.status(500).send("Error processing enquiry");
  }
});

app.get("/enquiries/:id", (req, res) => {
  const enquiryId = req.params.id;
  res.send(`Enquiry ${enquiryId} details`);
});

app.get("/property/:id", (req, res) => {
  const propertyId = req.params.id;
  res.send(`Property ${propertyId} details`);
});

app.get("/qcStatus/:id", (req, res) => {
  const qcId = req.params.id;
  res.send(`Property ${qcId} details`);
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.use(
  cors({
    origin: "https://test-acn-resale-inventories-dde03.web.app",
  })
);

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
