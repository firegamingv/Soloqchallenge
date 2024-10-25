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



mongoose.connect('mongodb://localhost:27017/leaderboard')
    .then(() => console.log('MongoDB connected...'))
    .catch(err => console.error('MongoDB connection error:', err));


app.use(express.static(path.join(__dirname, 'public')));


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


const summonerDataDir = path.join(__dirname, 'summoner_data');


function loadSummonerDataFromJson() {
    const summonerJsonPath = path.join(__dirname, 'summoners.json');
    if (fs.existsSync(summonerJsonPath)) {
        const data = fs.readFileSync(summonerJsonPath, 'utf8');
        return JSON.parse(data);
    } else {
        console.error('summoners.json not found.');
        return [];
    }
}


function getSummonerFilePath(puuid) {
    return path.join(summonerDataDir, `${puuid}.json`);
}


function loadSummonerFile(puuid) {
    const filePath = getSummonerFilePath(puuid);
    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    }
    return null;
}


function saveSummonerFile(puuid, data) {
    const filePath = getSummonerFilePath(puuid);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`Data for ${puuid} saved to ${filePath}`);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


async function fetchElo(encryptedSummonerId) {
    try {
        await delay(50);
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


async function fetchMatchHistory(puuid) {
    try {
        await delay(50);
        const response = await axios.get(`https://${MATCH_REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=5&api_key=${process.env.RIOT_API_KEY}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching match history for summoner ${puuid}: ${error.message}`, error.response?.data);
        return [];
    }
}


async function fetchMatchDetails(matchId, puuid) {
    try {
        await delay(50);
        const response = await axios.get(`https://${MATCH_REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}?api_key=${process.env.RIOT_API_KEY}`);
        const matchData = response.data;


        const participant = matchData.info.participants.find(p => p.puuid === puuid);

        if (participant) {
            return {
                matchId: matchId,
                win: participant.win,
                kills: participant.kills,
                deaths: participant.deaths,
                championName: participant.championName
            };
        }

        return null;
    } catch (error) {
        console.error(`Error fetching match details for match ID ${matchId}:`, error.message);
        return null;
    }
}


async function updateSummonersData() {
    const summoners = loadSummonerDataFromJson();

    try {
        for (const summoner of summoners) {
            console.log(`Updating data for summoner: ${summoner.name}, PUUID: ${summoner.puuid}`);


            const newMatchIds = await fetchMatchHistory(summoner.puuid);
            const existingMatchIds = summoner.matchHistory ? summoner.matchHistory.map(match => match.matchId) : [];
            const newMatchIdsToFetch = newMatchIds.filter(matchId => !existingMatchIds.includes(matchId));


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


            summoner.matchHistory = [...detailedMatchHistory, ...(summoner.matchHistory || [])].slice(0, 5);


            const totalMatches = summoner.matchHistory.length;
            const totalWins = summoner.matchHistory.filter(match => match.win).length;
            summoner.winrate = totalMatches ? ((totalWins / totalMatches) * 100).toFixed(2) + '%' : '0%';


            const eloData = await fetchElo(summoner.encryptedSummonerId);
            if (eloData) {
                Object.assign(summoner, eloData);
            }


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


cron.schedule('* * * * *', () => {
    console.log('Updating summoner data...');
    updateSummonersData();
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
