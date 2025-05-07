const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
require("dotenv").config();
const cron = require("node-cron");

const app = express();
const port = process.env.PORT || 3000;
const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://acnonline.in";

// Initialize Firebase - check for environment variables first, then fallback to json file
let firebaseConfig;
if (
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
) {
  firebaseConfig = {
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  };
}

admin.initializeApp(firebaseConfig);
const db = admin.firestore();

// Configure log level from environment
const logLevel = process.env.LOG_LEVEL || "info";
const shouldLog = (level) => {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  return levels[level] <= levels[logLevel];
};

const sendNotificationToAgent = async (cpId, title, body, data) => {
  try {
    // Get the agent's FCM token from Firestore
    const agentRef = db.collection("agents").doc(cpId);
    const agentDoc = await agentRef.get();

    if (!agentDoc.exists) {
      shouldLog("info") && console.log(`Agent ${cpId} not found`);
      return { success: false, message: `Agent ${cpId} not found` };
    } else {
      shouldLog("debug") && console.log(`Agent ${cpId} found`);
    }

    const agentData = agentDoc.data();
    const isArray = Array.isArray(agentData.fsmToken);
    const tokens = isArray ? agentData.fsmToken : [agentData.fsmToken];

    if (tokens.length === 0) {
      shouldLog("warn") &&
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

    // Get timeout from environment or use default
    const notificationTimeout =
      parseInt(process.env.NOTIFICATION_TIMEOUT) || 5000;

    // Send notification to each token for this agent
    for (const token of tokens) {
      try {
        // Add token to the message
        message.token = token;

        // Send the notification with timeout
        const sendPromise = admin.messaging().send(message);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Notification timeout")),
            notificationTimeout
          )
        );

        const res = await Promise.race([sendPromise, timeoutPromise]);

        shouldLog("info") &&
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
            shouldLog("info") &&
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
            shouldLog("info") &&
              console.log(`🗑 Deleted fsmToken field from agent ${cpId}`);
          }
        } else {
          shouldLog("warn") &&
            console.log(
              `⚠ Failed to send to ${cpId} (token: ${token.slice(
                0,
                8
              )}...) — ${code}: ${err.message}`
            );
        }
      }
    }

    return {
      success: successCount > 0,
      sent: successCount,
      total: tokens.length,
    };
  } catch (err) {
    shouldLog("error") &&
      console.error(`❌ Error processing notification for agent ${cpId}:`, err);
    return { success: false, error: err.message };
  }
};

// Routes remain largely the same, with minor improvements
app.post("/property/:id", async (req, res) => {
  const propertyId = req.params.id;
  shouldLog("debug") && console.log(`Processing property ID: ${propertyId}`);

  try {
    const propertyRef = db.collection("ACN123").doc(propertyId);
    const propertyDoc = await propertyRef.get();

    if (!propertyDoc.exists) {
      return res.status(404).send("Property Not Found");
    }

    const propertyData = propertyDoc.data();

    const result = await sendNotificationToAgent(
      propertyData.cpCode,
      `Listing Live!`,
      `Your listing for ${propertyData.nameOfTheProperty} is now live ${propertyData.propertyId}.`,
      { additionalData: "optional-value", type: "property_notification" }
    );

    res.status(200).json({
      message: "Notification processed successfully",
      result,
    });
  } catch (error) {
    shouldLog("error") &&
      console.error("Error processing property notification:", error);
    res.status(500).send("Error sending notification");
  }
});

app.post("/qcstatus/:id", async (req, res) => {
  const qcId = req.params.id;
  shouldLog("debug") && console.log("Processing QC status for ID:", qcId);

  try {
    const qcRef = db.collection("QC_Inventories").doc(qcId);
    const qcDoc = await qcRef.get();

    if (!qcDoc.exists) {
      shouldLog("info") && console.log("QC Document Not Found!");
      return res.status(404).send("Property Not Found");
    }

    const qcData = qcDoc.data();
    shouldLog("debug") && console.log("QC Data:", qcData);

    // Fix: changed res(200) to res.status(200)
    if (qcData.qcStatus === "available") {
      return res
        .status(200)
        .send("Listed! Sending Notification with property Id.");
    }

    let title, body;
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
        body = `Your listing for ${qcData.nameOfTheProperty} was rejected.`;
        break;
      case "pending":
        title = "Duplicate Listing Detected";
        body = `This unit in ${qcData.nameOfTheProperty} is already listed by another agent`;
        break;
      default:
        title = "Listing Submitted!";
        body = `Your listing for ${qcData.nameOfTheProperty} is under review.`;
        break;
    }

    shouldLog("debug") && console.log(`Notification: ${title} - ${body}`);

    const result = await sendNotificationToAgent(qcData.cpCode, title, body, {
      additionalData: "optional-value",
      type: "qc_notification",
      status: qcData.qcStatus,
    });

    res.status(200).json({
      message: "Successfully Sent Notification",
      result,
    });
  } catch (error) {
    shouldLog("error") &&
      console.error("Error processing QC notification:", error);
    res.status(500).send("Error sending notification");
  }
});

async function inBoundEnquiries(cpId) {
  try {
    const agentDocRef = db.collection("agents").doc(cpId);
    const agentDoc = await agentDocRef.get();
    const agentData = agentDoc.data();
    const inBound = agentData.inboundEnqCredits;
    await agentDocRef.update({ inboundEnqCredits: inBound - 1 });
    res.status(200).send("Successfull Deducted");
  } catch {
    res.status(500).send("Problem Deducting enquiries");
  }
}

app.post("/enquiries/:id", async (req, res) => {
  const enquiryId = req.params.id;
  shouldLog("debug") && console.log(`Processing enquiry ID: ${enquiryId}`);

  try {
    // Fetch the enquiry data from Firestore using the enquiryId
    const enquiryRef = db.collection("enquiries").doc(enquiryId);
    const enquiryDoc = await enquiryRef.get();

    if (!enquiryDoc.exists) {
      shouldLog("info") && console.log(`Enquiry ${enquiryId} not found`);
      return res.status(404).send("Enquiry not found");
    }

    const enquiryData = enquiryDoc.data();

    // Send to the person who sent the enquiry
    const results1 = await sendNotificationToAgent(
      enquiryData.cpId,
      `Enquiry Sent to Agent!`,
      `You've enquired about ${enquiryData.propertyId}. Check "My Enquiries" to track status.`,
      { additionalData: "optional-value", type: "enquiry_buyer_notification" }
    );

    shouldLog("debug") &&
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

    let results2 = { success: false, message: "Seller agent not found" };

    try {
      inBoundEnquiries(sellerAgentCpId);
    } catch {
      res.status(500).send("Error deducting in Bound Enquiries");
    }

    if (sellerAgentCpId && propertyName) {
      results2 = await sendNotificationToAgent(
        sellerAgentCpId,
        `New Enquiry Received!`,
        `${buyerAgentName} enquired about ${propertyName} ${enquiryData.propertyId}.`,
        {
          additionalData: "optional-value",
          type: "enquiry_seller_notification",
        }
      );

      shouldLog("debug") &&
        console.log("Notification results (seller):", results2);
    } else {
      shouldLog("warn") &&
        console.warn(
          `Property not found for enquiry ${enquiryData.propertyId}`
        );
    }

    res.status(200).json({
      message: "Enquiry processed successfully",
      buyerNotification: results1,
      sellerNotification: results2,
    });
  } catch (error) {
    shouldLog("error") && console.error("Error processing enquiry:", error);
    res.status(500).send("Error processing enquiry");
  }
});

// GET routes
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
  res.send("ACN Notifications API");
});

app.use(cors());

app.use(
  cors({
    origin: allowedOrigin,
  })
);

// Start the server
app.listen(port, () => {
  shouldLog("info") &&
    console.log(`Server running at http://localhost:${port}`);
  shouldLog("info") && console.log(`CORS allowed origin: ${allowedOrigin}`);
});

const deListNotification = async () => {
  try {
    console.log("Scheduler triggered: Updating inventory ages");

    // Reference the 'ACN123' collection
    const collectionRef = db.collection("ACN123");

    // Current Unix timestamp (in seconds)
    const currentUnixTime = Math.floor(Date.now() / 1000);

    // Set batch size limit to 500 (Firestore batch max size)
    const batchSize = 500;

    // Get documents in batches to handle large collections
    let documentsProcessed = 0;
    let lastDocument = null;

    while (true) {
      let query = collectionRef.orderBy("__name__").limit(batchSize);
      if (lastDocument) {
        query = query.startAfter(lastDocument);
      }

      const snapshot = await query.get();

      if (snapshot.empty) {
        console.log("All documents processed.");
        break;
      }

      const batch = db.batch();

      snapshot.forEach((doc) => {
        const data = doc.data();
        const { dateOfInventoryAdded, dateOfStatusLastChecked, status } = data;

        const updates = {};
        if (dateOfInventoryAdded) {
          updates.ageOfInventory = Math.floor(
            (currentUnixTime - dateOfInventoryAdded) / (60 * 60 * 24)
          );
        }
        if (dateOfStatusLastChecked) {
          updates.ageOfStatus = Math.floor(
            (currentUnixTime - dateOfStatusLastChecked) / (60 * 60 * 24)
          );
        }

        if (updates.ageOfStatus === 12 && status === "Available") {
          (async () => {
            try {
              const results = await sendNotificationToAgent(
                updates.cpCode,
                `${updates.nameOfTheProperty} delists in 3 days`,
                `Your listing goes hidden in 3 days unless you update its status.`,
                { additionalData: "optional-value" }
              );
              console.log("Notification results:", results);
            } catch (error) {
              console.error("Error executing campaign:", error);
            }
          })();
        } else if (updates.ageOfStatus === 13 && status === "Available") {
          (async () => {
            try {
              const results = await sendNotificationToAgent(
                updates.cpCode,
                `${updates.nameOfTheProperty} delists in 2 days`,
                `Don’t lose visibility—update within 48 hours.`,
                { additionalData: "optional-value" }
              );
              console.log("Notification results:", results);
            } catch (error) {
              console.error("Error executing campaign:", error);
            }
          })();
        } else if (updates.ageOfStatus === 14 && status === "Available") {
          (async () => {
            try {
              const results = await sendNotificationToAgent(
                updates.cpCode,
                `${updates.nameOfTheProperty} delists tomorrow`,
                `Last chance! Update now or it vanishes from ACN.`,
                { additionalData: "optional-value" }
              );
              console.log("Notification results:", results);
            } catch (error) {
              console.error("Error executing campaign:", error);
            }
          })();
        } else if (updates.ageOfStatus === 15 && status === "Available") {
          (async () => {
            try {
              const results = await sendNotificationToAgent(
                updates.cpCode,
                `Listing Hidden`,
                `${updates.nameOfTheProperty} is now hidden due to no status update.`,
                { additionalData: "optional-value" }
              );
              console.log("Notification results:", results);
            } catch (error) {
              console.error("Error executing campaign:", error);
            }
          })();
        }
      });
    }
  } catch {
    return;
  }
};

async function getMicromarketToCpIdMapping() {
  try {
    // Reference to the agents collection
    const agentsRef = db.collection("agents");

    // Query for agents with micromarket field
    // Note: Firestore doesn't have a direct $exists operator like MongoDB
    // We can query for non-null values though
    const snapshot = await agentsRef
      .where("preferedMicromarket", "!=", null)
      .select("cpId", "preferedMicromarket")
      .get();

    // Create the mapping object
    let micromarketToCpIdMap = {};

    // Process the results to build our mapping
    snapshot.forEach((doc) => {
      const data = doc.data();
      const cpId = data.cpId;
      const micromarket = data.preferedMicromarket;

      // Skip if any required field is missing
      if (!cpId || !micromarket) return;

      // If this is the first time we're seeing this micromarket, initialize the array
      if (!micromarketToCpIdMap[micromarket]) {
        micromarketToCpIdMap[micromarket] = [];
      }

      // Add this cpId to the micromarket's array
      micromarketToCpIdMap[micromarket].push(cpId);
    });

    return micromarketToCpIdMap;
  } catch (error) {
    console.error("Error mapping micromarkets to cpIds:", error);
    throw error;
  }
}

async function getLast24HoursProperties() {
  try {
    // Calculate timestamp for 24 hours ago
    const twentyFourHoursago = new Date();
    twentyFourHoursago.setHours(twentyFourHoursago.getHours() - 24);
    const twentyFourHoursAgo = Math.floor(twentyFourHoursago.getTime() / 1000);

    // Reference to the properties collection in ACN123 database
    const propertiesRef = db.collection("ACN123");

    // Query for properties added in the last 24 hours
    const snapshot = await propertiesRef
      .where("dateOfInventoryAdded", ">=", twentyFourHoursAgo)
      .get();

    // Initialize result objects
    const countByMicromarket = {}; // Just counts by micromarket

    // Process the results
    snapshot.forEach((doc) => {
      const property = doc.data();
      const micromarket = property.micromarket || "unassigned";

      // Initialize arrays/counts if this is the first property for this micromarket
      if (!countByMicromarket[micromarket]) {
        countByMicromarket[micromarket] = 0;
      }

      // Increment the count for this micromarket
      countByMicromarket[micromarket]++;
    });

    // Return either the full data or just the counts based on the parameter
    return countByMicromarket;
  } catch (error) {
    console.error("Error fetching recent properties by micromarket:", error);
    throw error;
  }
}

const preferedMicromarket = async () => {
  // Get the mapping of micromarkets to cpIds
  const micromarketToCpIdMap = await getMicromarketToCpIdMapping();

  // Get properties added in the last 24 hours grouped by micromarket
  const recentPropertiesByMicromarket = await getLast24HoursProperties();

  console.log(
    micromarketToCpIdMap,
    "Micromarket -> []\n",
    recentPropertiesByMicromarket,
    "Micromarket -> count"
  );

  for (const micromarket in recentPropertiesByMicromarket) {
    // Get the properties for this micromarket
    const properties = recentPropertiesByMicromarket[micromarket];

    // Get the count of properties in this micromarket
    const propertyCount = properties;

    // Get the agents associated with this micromarket (if any)
    const associatedAgents = micromarketToCpIdMap[micromarket] || [];

    // console.log(associatedAgents, "HOLA AMIGO");

    // Log the micromarket, agent IDs, and property count

    // console.log(`Micromarket: ${micromarket}`);
    // console.log(`- Properties in last 24 hours: ${propertyCount}`);
    // console.log(`- Associated agents (${associatedAgents.length}): ${associatedAgents.join(', ') || 'None'}`);
    // console.log('-----------------------------------');
    for (const agentId in associatedAgents) {
      const agentsRef = db.collection("agents");

      // Query for agents with micromarket field
      // Note: Firestore doesn't have a direct $exists operator like MongoDB
      // We can query for non-null values though
      const snapshot = await agentsRef
        .where("cpId", "==", associatedAgents[agentId])
        .select("name")
        .get();

      const doc = snapshot.docs[0].data();
      console.log(doc);

      if (propertyCount === 1) {
        sendNotificationToAgent(
          associatedAgents[agentId],
          `${propertyCount} new Property in ${micromarket}`,
          `Hey ${doc.name}, ${propertyCount} new property was added in ${micromarket} in the last 24 hours! Check them out now!`,
          { additionalData: "optional-value", type: "property_notification" }
        );
      } else {
        sendNotificationToAgent(
          associatedAgents[agentId],
          `${propertyCount} new Properties in ${micromarket}`,
          `Hey ${doc.name}, ${propertyCount} new properties were added in ${micromarket} in the last 24 hours! Check them out now!`,
          { additionalData: "optional-value", type: "property_notification" }
        );
      }
    }
  }

  // Also check if there are any micromarkets with agents but no recent properties
  console.log("\nMicromarkets with agents but no recent properties:");
  for (const micromarket in micromarketToCpIdMap) {
    if (!recentPropertiesByMicromarket[micromarket]) {
      const agents = micromarketToCpIdMap[micromarket];
      console.log(
        `- ${micromarket}: ${agents.length} agents (${agents.join(", ")})`
      );
    }
  }
};
const task = () => {
  console.log("I run today");
  deListNotification();
};

cron.schedule("0 8 * * *", task); // Runs every minute
cron.schedule("0 10 * * *", preferedMicromarket);
