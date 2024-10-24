const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const REGION = 'euw1';  // Utilisé pour la ligue, etc.
const MATCH_REGION = 'europe';  // Utilisé pour l'API des matchs


// MongoDB connection
mongoose.connect('mongodb://localhost:27017/leaderboard')
    .then(() => console.log('MongoDB connected...'))
    .catch(err => console.error('MongoDB connection error:', err));

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Summoner schema (optional if you're also saving to MongoDB)
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
    matchHistory: { type: [Object] }
}));

// Directory where summoner data is stored
const summonerDataDir = path.join(__dirname, 'summoner_data');

// Load summoner data from summoners.json
function loadSummonerDataFromJson() {
    const summonerJsonPath = path.join(__dirname, 'summoners.json');
    if (fs.existsSync(summonerJsonPath)) {
        const data = fs.readFileSync(summonerJsonPath, 'utf8');
        return JSON.parse(data);  // Return parsed summoners
    } else {
        console.error('summoners.json not found.');
        return [];
    }
}

// Get file path for a specific player's data based on puuid
function getSummonerFilePath(puuid) {
    return path.join(summonerDataDir, `${puuid}.json`);
}

// Load a summoner's detailed data from their file
function loadSummonerFile(puuid) {
    const filePath = getSummonerFilePath(puuid);
    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);  // Return parsed summoner data
    }
    return null;
}

// Save a summoner's data to their file
function saveSummonerFile(puuid, data) {
    const filePath = getSummonerFilePath(puuid);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`Data for ${puuid} saved to ${filePath}`);
}
// Function to add a delay between requests
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch detailed ELO data for a summoner
async function fetchElo(encryptedSummonerId) {
    try {
        await delay(50);  // Delay to avoid exceeding rate limits (20 requests/second)
        const response = await axios.get(`https://${REGION}.api.riotgames.com/lol/league/v4/entries/by-summoner/${encryptedSummonerId}?api_key=${process.env.RIOT_API_KEY}`);
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
        console.error(`Error fetching ELO for summoner ${encryptedSummonerId}: ${error.message}`, error.response?.data);
        return null;
    }
}

// Fetch match history for a summoner using the PUUID
async function fetchMatchHistory(puuid) {
    try {
        await delay(50);  // Delay to avoid exceeding rate limits
        const response = await axios.get(`https://${MATCH_REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=5&api_key=${process.env.RIOT_API_KEY}`);
        return response.data;  // Returns array of match IDs
    } catch (error) {
        console.error(`Error fetching match history for summoner ${puuid}: ${error.message}`, error.response?.data);
        return [];
    }
}

// Fetch detailed match data for each match ID, including kills, deaths, and champion
async function fetchMatchDetails(matchId, puuid) {
    try {
        await delay(50);  // Delay to avoid exceeding rate limits
        const response = await axios.get(`https://${MATCH_REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}?api_key=${process.env.RIOT_API_KEY}`);
        const matchData = response.data;

        // Find the summoner's performance in the match using the puuid
        const participant = matchData.info.participants.find(p => p.puuid === puuid);

        if (participant) {
            return {
                matchId: matchId,
                win: participant.win,
                kills: participant.kills,
                deaths: participant.deaths,
                championName: participant.championName  // Champion played in the match
            };
        }

        return null;
    } catch (error) {
        console.error(`Error fetching match details for match ID ${matchId}:`, error.message);
        return null;
    }
}

// Update ELO, match history, and calculate winrate for all summoners
async function updateSummonersData() {
    const summoners = loadSummonerDataFromJson();  // Load summoner data from summoners.json

    try {
        for (const summoner of summoners) {
            console.log(`Updating data for summoner: ${summoner.name}, PUUID: ${summoner.puuid}`);

            // Fetch match history and filter new matches
            const newMatchIds = await fetchMatchHistory(summoner.puuid);
            const existingMatchIds = summoner.matchHistory ? summoner.matchHistory.map(match => match.matchId) : [];
            const newMatchIdsToFetch = newMatchIds.filter(matchId => !existingMatchIds.includes(matchId));

            // Fetch detailed match data for new match IDs with rate limiting
            const detailedMatchHistory = [];
            let winCount = 0;
            let matchCount = 0;

            for (const matchId of newMatchIdsToFetch) {
                const matchDetails = await fetchMatchDetails(matchId, summoner.puuid);
                if (matchDetails) {
                    detailedMatchHistory.push(matchDetails);
                    if (matchDetails.win) winCount++;
                    matchCount++;
                }
            }

            // Combine new matches with the existing match history, and keep only the last 5 matches
            summoner.matchHistory = [...detailedMatchHistory, ...(summoner.matchHistory || [])].slice(0, 5);

            // Calculate winrate based on last 5 matches
            const totalMatches = summoner.matchHistory.length;
            const totalWins = summoner.matchHistory.filter(match => match.win).length;
            summoner.winrate = totalMatches ? ((totalWins / totalMatches) * 100).toFixed(2) + '%' : '0%';

            // Fetch and update ELO after updating match history
            const eloData = await fetchElo(summoner.encryptedSummonerId);
            if (eloData) {
                Object.assign(summoner, eloData);
            }

            // Save the updated summoner data to their file
            console.log(`Saving data for summoner: ${summoner.name}, PUUID: ${summoner.puuid}`);
            saveSummonerFile(summoner.puuid, summoner);
        }

        console.log('Summoner data updated with detailed match history and winrate.');
    } catch (error) {
        console.error('Error updating summoners data:', error.message);
    }
}

// Leaderboard route
app.get('/leaderboard', async (req, res) => {
    try {
        // Load all summoner files from the summoner_data directory
        const summonerFiles = fs.readdirSync(summonerDataDir);
        const summoners = summonerFiles.map(file => {
            const puuid = path.basename(file, '.json');
            return loadSummonerFile(puuid);
        });

        res.json(summoners);
    } catch (error) {
        res.status(500).json({ error: 'Error fetching leaderboard data' });
    }
});

// Update data every minute using cron job
cron.schedule('* * * * *', () => {
    console.log('Updating summoner data...');
    updateSummonersData();
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
