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

// API key
const API_KEY = process.env.RIOT_API_KEY;
const REGION = 'euw1';  // Change to your desired region

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
        console.error(`Error fetching ELO for summoner ${encryptedSummonerId}:`, error.response ? error.response.data : error.message);
        return null;
    }
}

// Fetch match history for a summoner
async function fetchMatchHistory(puuid) {
    try {
        const response = await axios.get(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=5&api_key=${API_KEY}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching match history for summoner ${puuid}:`, error.response ? error.response.data : error.message);
        return [];
    }
}

// Function to update ELO and match history for a summoner
async function updateSummonerData(summoner) {
    try {
        const eloData = await fetchElo(summoner.encryptedSummonerId);
        const matchHistory = await fetchMatchHistory(summoner.puuid);

        if (eloData) {
            // Update only if data has changed
            summoner.leagueId = eloData.leagueId;
            summoner.queueType = eloData.queueType;
            summoner.tier = eloData.tier;
            summoner.rank = eloData.rank;
            summoner.leaguePoints = eloData.leaguePoints;
            summoner.wins = eloData.wins;
            summoner.losses = eloData.losses;
            summoner.hotStreak = eloData.hotStreak;
        }

        if (JSON.stringify(summoner.matchHistory) !== JSON.stringify(matchHistory)) {
            summoner.matchHistory = matchHistory;
        }
        return true;
    } catch (error) {
        console.error(`Error updating summoner data for ${summoner.name}`, error);
        return false;
    }
}

// Leaderboard route
// Leaderboard route
app.get('/leaderboard', async (req, res) => {
    try {
        let dataUpdated = false;

        // Check for updates in ELO or match history for each summoner
        for (let summoner of summonersData) {
            const hasUpdated = await updateSummonerData(summoner);
            if (hasUpdated) {
                dataUpdated = true;
            }
        }

        // If any data has been updated, write back to the JSON file
        if (dataUpdated) {
            fs.writeFileSync('summoners.json', JSON.stringify(summonersData, null, 2));
            console.log('Summoner data updated.');
        }

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

        // Sort summoners by combined tier points and league points
        const sortedSummoners = summonersData.sort((a, b) => {
            // Calculate the total score for each summoner
            const aScore = (tierPoints[a.tier] || 0) + a.leaguePoints;
            const bScore = (tierPoints[b.tier] || 0) + b.leaguePoints;

            return bScore - aScore; // Sort in descending order
        });

        res.json(sortedSummoners);
    } catch (error) {
        res.status(500).json({ error: 'Error fetching leaderboard data' });
    }
});



// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
