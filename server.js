require("dotenv").config();
const PORT = process.env.PORT || 8080
const cors = require("cors");
const express = require('express');
const youtubedl = require('youtube-dl-exec');
const app = express();
const yts = require('yt-search');

const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const crypto = require("crypto");

const Redis = require("ioredis");
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
redis.on("connect",()=> console.log("Connection Established with Redis"))
redis.on("error", (err) => console.log("Redis Error:", err));
mongoose.connect(process.env.DB_URL)
    .then(console.log("Connection Established with MongoDB"))
    .catch((err)=>console.error("Connection Failed : ",err))
app.use(express.json());


app.use(cors({
  origin: "*", // During dev, allow your frontend ngrok URL
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"],
  credentials: true
}));
app.get("/",(req,res)=>{
    res.send("This Backend is Actually running");

})


app.get("/search",async(req,res)=>{
    const query = req.query.q;
    
    try {
        
        const response = await fetch(`https://www.googleapis.com/youtube/v3/search?q=${encodeURIComponent(query)}&part=snippet&type=video&maxResults=50&key=${process.env.GOOGLE_API_KEY}`);

        
        const data = await response.json();

        if (!data.items){
            res.json([])
        }
        const results = await Promise.all(data.items.map(async (item) => {
            return {
                name: item.snippet.title,
                
                audiosrc: `/getaudio?v=${item.id.videoId}`, 
                thumbnail: item.snippet.thumbnails.medium.url,
                artist: item.snippet.channelTitle,
                id: item.id.videoId
            };
        }));
        res.json(results)
        console.log(results)
        }
        catch{
        res.status(500).json({response:"nahhh"})
        console.error(error)
    }
})

app.get("/getaudio",async(req,res)=>{
    const videoId= req.query.v;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let cachedlink;
    try{
        cachedlink = await redis.get(videoId)
    }catch(err){
        console.log("Redis is not responding getting from source ...")
    }
     try {
    
    if (cachedlink){
        res.redirect(cachedlink)
    }else{
        const audioUrl = await youtubedl(videoUrl, {
  getUrl: true,
  // Improved format selector (this fixes most "Requested format is not available" errors)
  format: 'bestaudio',

  // Modern YouTube workarounds (very important right now)
  extractorArgs: 'youtube:player_client=android,web,ios',

  noWarnings: true,
  noCheckCertificates: true,
  ignoreConfig: true,
  concurrentFragments: 8,        // slightly higher is usually fine on Railway
  cookies: 'cookies.txt',        // keep if you're using login cookies

  // Extra safety options
  // ignoreErrors: true,         // uncomment only if you want to be very lenient
});
    await redis.set(videoId,audioUrl,"EX",18000)
    res.redirect(audioUrl)
    }
    
  } catch (error) {
    console.error('Error fetching stream:', error);
    
  }
    
})
const JWTSecret = process.env.JWT_SECRET;
const users = [];
function verifyToken(req,res,next){
    const authHeader= req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1]
    if(!token){
        if(req.query.token){
            jwt.verify(req.query.token,JWTSecret,async(err,decodedUser)=>{
            if(err){
                res.status(403).send("Access Denied:Token is fake or expired")
            }else{
                const target = await User.findOne({userId:decodedUser.userId})
                if(target){
                    req.user={username:target.username,userId:decodedUser.userId}
                    next();
                }else{
                    res.status(403).send("Access Denied: User no longer exists")
                }
            }
        })
        }else{
            res.status(401).send("Access Denied : Authorization Token is required!")
        }
    }else{
        jwt.verify(token,JWTSecret,async(err,decodedUser)=>{
            if(err){
                res.status(403).send("Access Denied:Token is fake or expired")
            }else{
                const target = await User.findOne({userId:decodedUser.userId})
                if(target){
                    req.user={username:target.username,userId:decodedUser.userId}
                    next();
                }else{
                    res.status(403).send("Access Denied: User no longer exists")
                }
            }
        })
    }
}

const getDiscovery = async (recentSeeds) => {
    // Construct the prompt with your specific object schema
    if (recentSeeds){
        const prompt = `
    You are a music recommendation engine.
    Seeds: ${JSON.stringify(recentSeeds.map(s => s.name + " by " + s.artist))}.
    Return EXACTLY 40 songs, no more no less.
    Shorts are excluded
    
    Return ONLY a valid JSON object in this exact format:
    { "songs": [{ "name": "Song Name", "artist": "Artist Name" }] }
    Do not explain anything, just the JSON.
    No song can be the same as the other.
`;;

    try {
        const response = await groq.chat.completions.create({
    model:"moonshotai/kimi-k2-instruct-0905",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" } 
});

const suggestions = JSON.parse(response.choices[0].message.content);
        console.log(suggestions)
        
        // Parse the AI string into a usable array
        return suggestions
    } catch (error) {
        console.error("Forge Discovery Error:", error);
        return [];
    }
    }else{
        return[]
    }
};
const getAIplaylistSongs=async(userprompt)=>{
    if(userprompt){
        const prompt= `
    You are an ai playlist generator based off user prompt.
    
    User Prompt :${userprompt}
    Return EXACTLY 15 songs and the playlist title , no more no less FROM YOUTUBE.
    Shorts are excluded
    
    Return ONLY a valid JSON object in this exact format:
    { "name":"The Playlist Title", "songs": [{ "name": "Song Name", "artist": "Artist Name" }] }
    Do not explain anything, just the JSON.
    `
    try {
        const response = await groq.chat.completions.create({
    model:"llama-3.1-8b-instant",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" } 
});

const parsed = JSON.parse(response.choices[0].message.content);
       
        
        // Parse the AI string into a usable array
        return {songs:parsed.songs,name:parsed.name,success:true,message:"Success"}
    } catch (error) {
        console.error("Forge Discovery Error:", error);
        return {songs:[],success:false,message:"Something went wrong"}
    }
    }else{
        return {songs:[],success:false,message:"Empty Prompt"}
    }
    

}
const userSchema = new mongoose.Schema({
    username:String,
    password:String,
    userId:String
})
const User = mongoose.model("User",userSchema)
const userBankSchema = new mongoose.Schema({
    userId:String,
    library:[String],
    playlists:[{
        id:String,
        name:String,
        songIds:[String]
    }]
})

const UserBank = mongoose.model("Userbank",userBankSchema);
const songSchema = new mongoose.Schema({
    id:String,
    name:String,
    artist:String,
    thumbnail:String,
    audiosrc:String
})
const Song = mongoose.model("Song",songSchema);

app.get("/api/aiplaylist",async(req,res)=>{
    const prompt = req.query.prompt;
    try{
        const ReturnedObj = await getAIplaylistSongs(prompt)
        const customId = crypto.randomBytes(6).toString('hex');
        if(ReturnedObj.success){
            const songsInfo = ReturnedObj.songs;
            console.log(songsInfo)
            const songs = await Promise.all(songsInfo.map(async (song) => {
                try {
                    const r = await yts(`${song.name} ${song.artist} official audio`);
                    const video = r.videos[0];
                    if (!video) return;
                    const result = {
                        name: video.title,
                        artist: video.author.name,
                        id: video.videoId,
                        audiosrc: `/getaudio?v=${video.videoId}`,
                        thumbnail: video.thumbnail,
                       
                    };
                    return result
                } catch (e) {}
            }))
            const Pack = {playlistObj:{id:customId,name:ReturnedObj.name,songs:songs},success:true,message:"Success"}
            res.json(Pack)
        }else{
            const Pack={playlistObj:{id:"",name:"",songs:[]},success:false,message:ReturnedObj.message}
            res.json(Pack)
        }
    }catch(err){
        console.error("Something went wrong :",err)
    }
})
app.post("/api/library/remove",verifyToken,async(req,res)=>{
    const {songId} = req.body;
    const userCreds= {username:req.user.username,userId:req.user.userId}
    try{
        await UserBank.findOneAndUpdate(
            {userId : userCreds.userId},
            {$pull: { library: songId }}
        )
        res.json({success:true,message:"Removed Successfully"})
    }catch(err){
        console.error("Failed to remove:",err)
    }
})
app.post("/api/library/add",verifyToken,async(req,res)=>{
    const { songData } = req.body
    const userCreds= {username:req.user.username,userId:req.user.userId}
    try {
        // kat9lab 3la song checking wach tma
        await Song.findOneAndUpdate(
            { id: songData.id }, 
            songData, 
            { upsert: true, new: true }
        );

        // k t saviha 3and l user
        await UserBank.findOneAndUpdate(
            { userId: userCreds.userId },
            { $addToSet: { library: songData.id } }
        );
        res.json({success:true,message:"Added to Library !"})
    }catch(err){
        console.error("Error add to lib:",err)
        res.status(500).send("Failed to add to library")
    }    
})
app.get("/api/library",verifyToken,async(req,res)=>{
    try{
        const userCreds= {username:req.user.username,userId:req.user.userId}
        const userBank= await UserBank.findOne({userId:userCreds.userId})
        const userLib = await Song.find({id:{$in:userBank.library}})

        res.json(userLib)
    }catch(err){
        console.error("Couldn't get library",err)
    }
    
})
app.get("/api/recentadds",verifyToken,async (req,res)=>{
    const userCreds= {username:req.user.username,userId:req.user.userId}
    try{
        const userBank = await UserBank.findOne({userId:userCreds.userId})
        const recentlyaddedIds = userBank.library.slice(-6)
        const recentlyadded = (await Song.find({id:{$in:recentlyaddedIds}})).reverse()
        res.json(recentlyadded);
    }catch(err){
        console.error(err);
        res.json({message:"Server Error"}).status(500)
    }
})
app.get("/api/discovery", verifyToken, async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    try {
        const userBank = await UserBank.findOne({ userId: req.user.userId });
        const recentlyaddedIds = userBank.library.slice(-5);
        const recentSeeds = await Song.find({ id: { $in: recentlyaddedIds } });

        const suggestions = await getDiscovery(recentSeeds);
        if (!suggestions || !suggestions.songs) {
            res.write(`data: [DONE]\n\n`);
            return res.end();
        }

        // Wait for all searches, send each as it finishes
        await Promise.allSettled(
            suggestions.songs.map(async (song) => {
                try {
                    const r = await yts(`${song.name} ${song.artist} official audio`);
                    const video = r.videos[0];
                    if (!video) return;
                    const result = {
                        name: video.title,
                        artist: video.author.name,
                        id: video.videoId,
                        audiosrc: `/getaudio?v=${video.videoId}`,
                        thumbnail: video.thumbnail,
                        duration: video.timestamp
                    };
                    res.write(`data: ${JSON.stringify(result)}\n\n`);
                } catch (e) {}
            })
        );

        res.write(`data: [DONE]\n\n`);
        res.end();

    } catch (err) {
        console.log(err);
        res.write(`data: [DONE]\n\n`);
        res.end();
    }
});
app.get("/api/playlists",verifyToken,async(req,res)=>{
    
    const userCreds= {username:req.user.username,userId:req.user.userId}
    try{
        const userBank = await UserBank.findOne({userId:userCreds.userId})
        const userPlaylists = await userBank.playlists
        res.json(userPlaylists)
    }catch(err){
        console.error("Couldn't get playlists",err)
    }
})
app.get("/api/playlists/songs",verifyToken,async(req,res)=>{
    const playlistId = req.query.id
    const userCreds= {username:req.user.username,userId:req.user.userId};
    try{
        const userBank= await UserBank.findOne({userId:userCreds.userId});
        const playlist = await userBank.playlists.find(p => p.id === playlistId);
        
        if (playlist.songIds && playlist.songIds.length > 0){
            const playlistSongs = await Song.find({id:{$in:playlist.songIds}})
            res.json({playlistSongs:playlistSongs,playlistobj:playlist})
        }else{
            res.json([])
        }
        

    }catch(err){    
        console.log("Couldnt get playlist songs :",err)

    }
})
app.post("/api/playlists/songs/remove",verifyToken,async(req,res)=>{
    const {playlistId,songId} = req.body;
    const userCreds= {username:req.user.username,userId:req.user.userId};
    try{
        await UserBank.findOneAndUpdate(
            {userId:userCreds.userId,
                "playlists.id":playlistId
            },
            {$pull:{"playlists.$.songIds":songId}}
        )
        res.json({success:true,message:"Removed song from playlist succesfully"})
    }catch(err){
        console.log("Couldnt pull song:",err);
        res.json({success:false,message:"Server Error"}).status(500)
    }
})
app.post("/api/playlists/songs/add",verifyToken,async(req,res)=>{
    const {playlistId,songIds,fromLibrary,songData} = req.body;
    const userCreds= {username:req.user.username,userId:req.user.userId};
    try{
        
        
        if(fromLibrary){
            await UserBank.findOneAndUpdate(
            { userId: userCreds.userId,
                "playlists.id":playlistId
             },
            { $addToSet: {"playlists.$.songIds":{$each:songIds}} }
        );
        res.json({success:true,message:"Added to Playlist !"})
        }else{
            await Song.findOneAndUpdate(
            { id: songData.id }, 
            songData, 
            { upsert: true, new: true }
        );
        // Combine all checks into one clean query
            const userDoc = await UserBank.findOne({ userId: userCreds.userId });

            if (!userDoc) {
                return res.status(404).json({ success: false, message: "User not found" });
            }

            // Find the playlist manually (avoids type mismatch issues with nested $elemMatch)
            const playlist = userDoc.playlists.find(p => p.id == playlistId); // == handles string/number mismatch

            if (!playlist) {
                return res.status(200).json({ success: false, message: "Playlist not found" });
            }

            // Check if song already exists
            if (playlist.songIds.includes(songData.id)) {
                return res.json({ success: false, message: "Song already in playlist!" });
            }

            // Add the song to the playlist
            await UserBank.findOneAndUpdate(
                { userId: userCreds.userId, "playlists.id": playlistId },
                { $push: { "playlists.$.songIds": songData.id } },
                { new: true }
            );

            res.json({ success: true, message: "Added to Playlist!" });
    }
    }catch(err){
        console.error("Error add to playlist:",err)
        res.status(500).send("Failed to add to playlist")
    }
})
app.post("/api/playlists/add",verifyToken,async(req,res)=>{
    const { PlaylistObj } = req.body
    const userCreds= {username:req.user.username,userId:req.user.userId}
    try{
        const result = await UserBank.findOneAndUpdate(
            { userId: userCreds.userId },
            { $addToSet: { playlists: PlaylistObj } },
            { new: true, upsert: false } 
        );

        console.log("3. DB Query Finished");

        if (!result) {
            console.log("4. User not found");
            return res.status(404).json({ success: false, message: "User not found" });
        }

        console.log("5. Success!");
        return res.status(200).json({ success: true, message: "Added Playlist Successfully" });
    }catch(err){
        res.json({success:false,message:"Couldnt Add Playlist"})
        console.log(err);
    }
})
app.post("/api/playlists/remove",verifyToken,async(req,res)=>{
    const {playlistId} = req.body;
    const userCreds= {username:req.user.username,userId:req.user.userId}
    try{
        await UserBank.findOneAndUpdate(
            {userId:userCreds.userId},
            {$pull:{playlists:{id:playlistId}}}
        )
        res.status(200).json({ success: true, message: "Removed Playlist Successfully" });
    }catch(err){
        res.json({success:false,message:"Couldnt Remove Playlist"})
        console.log(err);
    }
})
app.post("/api/library/clear",verifyToken,async(req,res)=>{
    const userId = req.user.userId;
    try{
        await UserBank.findOneAndUpdate(
            {userId:userId},
            {library:[]}
        )
        res.json({success:true,message:"Library Cleared Succesfully"})
    }catch(err){
        console.error("Couldnt clear library",err)
        res.json({success:false,message:err})
    }
})
app.post("/api/playlists/clear",verifyToken,async(req,res)=>{
    const userId = req.user.userId;
    try{
        await UserBank.findOneAndUpdate(
            {userId:userId},
            {playlists:[]}
        )
        res.json({success:true,message:"Playlists Cleared Succesfully"})
    }catch(err){
        console.error("Couldnt clear playlists",err)
        res.json({success:false,message:err})
    }
})
app.post("/users/register",async(req,res)=>{
    const customId = crypto.randomBytes(6).toString('hex');
    const requser ={username:req.body.username,password:req.body.password}
    const hashedPass = await bcrypt.hash(requser.password,10)
    const userCheck = await User.findOne({username:requser.username});
    if (userCheck){
        return res.json({
            message:"Username already taken!",
            loggedin:false
        })
    }else{
        const newUser = User({username:requser.username,password:hashedPass,userId:customId})
        await newUser.save()
        const newUserData = UserBank({
            userId:customId,
            library:[],
            playlists:[]
        })
        await newUserData.save()
        const payload= {userId:customId}
            const token = jwt.sign(payload,JWTSecret,{expiresIn:"7d"})
            res.json({
                message:"Registred Successfully !",
                token:token,
                loggedin:true
            })
    }
    
    

})

app.post("/users/login",async(req,res)=>{
    const user = await User.findOne({username:req.body.username});
    if(user===null){
        return res.send("User not found").status(404);
    }else{
        const isMatch = await bcrypt.compare(req.body.password,user.password)
        if(isMatch){
            const payload= {userId:user.userId}
            const token = jwt.sign(payload,JWTSecret,{expiresIn:"7d"})
            res.json({
                message:"Login Succesful :D",
                token:token,
                loggedin:true
            })

        }else{
            res.send("Access Denied to the specified user").status(403)
        }
    }
})
app.get("/users/session",verifyToken,(req,res)=>{
    try{
        res.json({username:req.user.username,userId:req.user.userId,isloggedin:true})
    }catch(err){
        console.error(err);
        res.json({message:err})
    }
})
app.post("/users/editusername",verifyToken,async(req,res)=>{
    const userId = req.user.userId;
    try{
        const {newUsername} = req.body;
        await User.findOneAndUpdate(
            {userId:userId},
            {username:newUsername}
        )
        res.json({success:true,message:"Edited Username Successfully"})
    
    }catch(err){
        console.error("Couldnt edit username:",err)
        res.json({
            success:true,
            message:err
        })
    }
})
app.post("/users/changepswd",verifyToken,async(req,res)=>{
    const userId = req.user.userId;
    try{
        const {currentPassword,newPassword} =req.body
        const user = await User.findOne({userId:userId})
        const isMatch =await bcrypt.compare(currentPassword,user.password);
        if(isMatch){
            const hash = await  bcrypt.hash(newPassword,10)
            await User.findOneAndUpdate({userId:userId},
            {password:hash}
            )
            res.json({success:true,message:"Changed password succesfully"})
    }else{
        res.json({success:false,message:"Wrong Password !"})
    }
        }catch(err){
            console.error("Couldnt change passowrd",err)
            res.json({success:false,message:err})
        }
        
})
app.post("/users/delete",verifyToken,async (req,res)=>{
    const userId = req.user.userId
    try{
        await UserBank.findOneAndDelete({userId:userId})
        await User.findOneAndDelete({userId:userId})
        res.json({success:true,message:"successfully deleted account"})
    }catch(err){
        console.error("Couldnt delete account",err)
        res.json({success:false,message:err})
    }
})
app.get("/users/getinfo",verifyToken,async(req,res)=>{
    const userCreds = {username:req.user.username,userId:req.user.userId}
    try{
        const userBank = await UserBank.findOne({userId:userCreds.userId})
        res.json({
            username:userCreds.username,
            userId : userCreds.userId,
            library:userBank.library.length,
            playlists:userBank.playlists.length
        }) 
    }catch(err){
        res.status(500);
        console.error("Couldnt get user info :",err)
    }
})
app.listen(PORT,() => {
    
    console.log("The Server is running at : localhost:8080")
})
