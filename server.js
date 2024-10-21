const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection
mongoose.connect('mongodb://localhost:27017/leaderboard')
    .then(() => console.log('MongoDB connected...'))
    .catch(err => console.error('MongoDB connection error:', err));

// Serve static files from the "public" directory
// Place your `index.html`, `styles.css`, etc. in the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// Summoner schema
const Summoner = mongoose.model('Summoner', new mongoose.Schema({
    name: { type: String, required: true },
    tagline: { type: String, required: true },
    puuid: { type: String, required: true },
    encryptedAccountId: { type: String, required: true },
    encryptedSummonerId: { type: String, required: true },
    elo: { type: String },
    leagueId: { type: String },
    queueType: { type: String },
    tier: { type: String },
    rank: { type: String },
    leaguePoints: { type: Number },
    wins: { type: Number },
    losses: { type: Number },
    hotStreak: { type: Boolean },
    matchHistory: { type: [String] }
}));

// Load summoners from JSON file
let summonersData;
try {
    if (!fs.existsSync('summoners.json')) {
        fs.writeFileSync('summoners.json', JSON.stringify([], null, 2));
    }

    const data = fs.readFileSync('summoners.json');
    summonersData = JSON.parse(data);
    console.log('Summoners loaded successfully:', summonersData);
} catch (error) {
    console.error('Error loading summoners.json:', error);
    summonersData = [];
}

// API key and region
const API_KEY = process.env.RIOT_API_KEY;
const REGION = 'euw1';

// Fetch detailed ELO data for a summoner
async function fetchElo(encryptedSummonerId) {
    try {
        const response = await axios.get(`https://${REGION}.api.riotgames.com/lol/league/v4/entries/by-summoner/${encryptedSummonerId}?api_key=${API_KEY}`);
        const rankedData = response.data.find(entry => entry.queueType === 'RANKED_SOLO_5x5');

        if (rankedData) {
            return {
                leagueId: rankedData.leagueId,
                summonerId: rankedData.summonerId,
                queueType: rankedData.queueType,
                tier: rankedData.tier,
                rank: rankedData.rank,
                leaguePoints: rankedData.leaguePoints,
                wins: rankedData.wins,
                losses: rankedData.losses,
                hotStreak: rankedData.hotStreak
            };
        }
        return null;
    } catch (error) {
        console.error(`Error fetching ELO for summoner ${encryptedSummonerId}:`, error.message);
        return null;
    }
}

// Fetch match history for a summoner
async function fetchMatchHistory(puuid) {
    try {
        const response = await axios.get(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=5&api_key=${API_KEY}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching match history for summoner ${puuid}:`, error.message);
        return [];
    }
}

// Update ELO and match history for all summoners in parallel
async function updateSummonersData() {
    try {
        const updatePromises = summonersData.map(async (summoner) => {
            const eloData = await fetchElo(summoner.encryptedSummonerId);
            const matchHistory = await fetchMatchHistory(summoner.puuid);

            if (eloData) {
                Object.assign(summoner, eloData);  // Merge new ELO data into the summoner object
            }

            if (JSON.stringify(summoner.matchHistory) !== JSON.stringify(matchHistory)) {
                summoner.matchHistory = matchHistory;
            }
        });

        await Promise.all(updatePromises);  // Run all updates in parallel
        fs.writeFileSync('summoners.json', JSON.stringify(summonersData, null, 2));  // Save updates to file
        console.log('Summoner data updated.');
    } catch (error) {
        console.error('Error updating summoners data:', error.message);
    }
}

// Leaderboard route
app.get('/leaderboard', async (req, res) => {
    try {
        // Define base points for each tier
        const tierPoints = {
            "Iron": 0,
            "Bronze": 100,
            "Silver": 200,
            "Gold": 300,
            "Platinum": 400,
            "Diamond": 500,
            "Master": 600,
            "Grandmaster": 700,
            "Challenger": 800
        };

        // Sort summoners by combined tier points and league points in descending order
        const sortedSummoners = summonersData.sort((a, b) => {
            const aScore = (tierPoints[a.tier] || 0) + a.leaguePoints;
            const bScore = (tierPoints[b.tier] || 0) + b.leaguePoints;
            return bScore - aScore;  // Descending order
        });

        res.json(sortedSummoners);
    } catch (error) {
        res.status(500).json({ error: 'Error fetching leaderboard data' });
    }
});

// Update data every hour using cron job
cron.schedule('0 * * * *', () => {
    console.log('Updating summoner data...');
    updateSummonersData();
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
