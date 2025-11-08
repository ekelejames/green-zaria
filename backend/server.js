// Green Zaria Backend Service
// Install: npm install express kafkajs multer uuid cors ws body-parser

const express = require('express');
const { Kafka } = require('kafkajs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'kafka:9092').split(',');

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static('uploads'));

// Create uploads directory
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Kafka Configuration
const kafka = new Kafka({
  clientId: 'green-zaria-service',
  brokers: KAFKA_BROKERS,
  retry: {
    retries: 8,
    initialRetryTime: 300,
    maxRetryTime: 30000
  },
  // SASL authentication if needed
  sasl: process.env.KAFKA_SASL_ENABLED === 'true' ? {
    mechanism: 'plain',
    username: process.env.KAFKA_SASL_USERNAME || 'admin',
    password: process.env.KAFKA_SASL_PASSWORD || 'admin-secret'
  } : undefined,
  ssl: process.env.KAFKA_SSL_ENABLED === 'true' || undefined
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'map-dashboard-group' });

// In-memory school database (replace with real DB in production)
const schools = new Map();

// Multer configuration for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only .png, .jpg and .jpeg format allowed!'));
  }
});

// Initialize Kafka
async function initKafka() {
  await producer.connect();
  console.log('Kafka Producer connected');
  
  await consumer.connect();
  await consumer.subscribe({ topic: 'school-outreach-events', fromBeginning: true });
  await consumer.subscribe({ topic: 'school-planting-events', fromBeginning: true });
  console.log('Kafka Consumer connected');
}

// API Routes

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// 1. Register School (Outreach)
app.post('/api/schools/register', async (req, res) => {
  try {
    const { name, address, coordinates, contactPerson, contactPhone } = req.body;
    
    if (!name || !coordinates || !coordinates.lat || !coordinates.lng) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const schoolId = uuidv4();
    const accessToken = uuidv4();
    
    const school = {
      schoolId,
      name,
      address,
      coordinates,
      contactPerson,
      contactPhone,
      accessToken,
      status: 'OUTREACHED',
      registeredAt: new Date().toISOString()
    };

    // Store in database
    schools.set(schoolId, school);

    // Produce to Kafka
    await producer.send({
      topic: 'school-outreach-events',
      messages: [{
        key: schoolId,
        value: JSON.stringify({
          schoolId,
          name,
          coordinates,
          status: 'OUTREACHED',
          timestamp: new Date().toISOString()
        })
      }]
    });

    console.log(`School registered: ${name} at ${coordinates.lat}, ${coordinates.lng}`);

    res.status(201).json({
      message: 'School registered successfully',
      schoolId,
      accessToken,
      school: {
        schoolId,
        name,
        coordinates,
        status: 'OUTREACHED'
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register school' });
  }
});

// 2. Upload Planting Evidence
app.post('/api/schools/:schoolId/upload-planting', upload.single('plantingImage'), async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { accessToken } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Verify school exists and token matches
    const school = schools.get(schoolId);
    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    if (school.accessToken !== accessToken) {
      return res.status(403).json({ error: 'Invalid access token' });
    }

    const imageUrl = `/uploads/${req.file.filename}`;

    // Update school status
    school.status = 'PLANTED';
    school.plantingImage = imageUrl;
    school.plantedAt = new Date().toISOString();

    // Produce to Kafka
    await producer.send({
      topic: 'school-planting-events',
      messages: [{
        key: schoolId,
        value: JSON.stringify({
          schoolId,
          name: school.name,
          coordinates: school.coordinates,
          imageUrl,
          status: 'PLANTED',
          timestamp: new Date().toISOString()
        })
      }]
    });

    console.log(`Planting evidence uploaded for: ${school.name}`);

    res.status(200).json({
      message: 'Planting evidence uploaded successfully',
      school: {
        schoolId,
        name: school.name,
        status: 'PLANTED',
        imageUrl
      }
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload planting evidence' });
  }
});

// 3. Get all schools (for initial map load)
app.get('/api/schools', (req, res) => {
  const schoolList = Array.from(schools.values()).map(school => ({
    schoolId: school.schoolId,
    name: school.name,
    coordinates: school.coordinates,
    status: school.status,
    plantingImage: school.plantingImage
  }));
  
  res.json(schoolList);
});

// WebSocket Server for Real-time Updates
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

// Broadcast to all WebSocket clients
function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Kafka Consumer - Listen for events and broadcast via WebSocket
async function startConsumer() {
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const event = JSON.parse(message.value.toString());
      console.log(`Received event from ${topic}:`, event);
      
      // Broadcast to WebSocket clients
      broadcast({
        topic,
        event
      });
    }
  });
}

// Start Server
async function start() {
  try {
    await initKafka();
    await startConsumer();
    
    app.listen(PORT, () => {
      console.log(`Green Zaria Backend running on http://localhost:${PORT}`);
      console.log(`WebSocket server running on ws://localhost:${WS_PORT}`);
      console.log('\nEndpoints:');
      console.log(`POST /api/schools/register - Register a school (outreach)`);
      console.log(`POST /api/schools/:schoolId/upload-planting - Upload planting evidence`);
      console.log(`GET /api/schools - Get all schools`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await producer.disconnect();
  await consumer.disconnect();
  process.exit(0);
});