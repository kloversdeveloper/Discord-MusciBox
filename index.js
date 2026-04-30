import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} from "@discordjs/voice";
import yts from "yt-search";
import youtubedl from "youtube-dl-exec";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const queue = [];

let connection = null;
let player = null;
let textChannel = null;
let currentSong = null;
let isPaused = false;

function isSpotifyTrack(url) {
  return url.includes("open.spotify.com/track/");
}

function isSpotifyPlaylist(url) {
  return url.includes("open.spotify.com/playlist/");
}

function isYouTubePlaylist(url) {
  return url.includes("youtube.com/playlist?list=") || url.includes("list=");
}

function isYouTubeVideo(url) {
  return url.includes("youtube.com/watch") || url.includes("youtu.be/");
}

async function getSpotifyToken() {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await res.json();

  if (!data.access_token) {
    throw new Error("Spotifyトークン取得に失敗しました");
  }

  return data.access_token;
}

function getSpotifyTrackId(url) {
  return url.match(/track\/([a-zA-Z0-9]+)/)?.[1];
}

function getSpotifyPlaylistId(url) {
  return url.match(/playlist\/([a-zA-Z0-9]+)/)?.[1];
}

async function getSpotifyTrack(url) {
  const id = getSpotifyTrackId(url);
  const token = await getSpotifyToken();

  const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await res.json();

  const artists = data.artists.map((a) => a.name).join(" ");

  return {
    type: "search",
    title: data.name,
    searchText: `${data.name} ${artists}`,
  };
}

async function getSpotifyPlaylist(url) {
  const id = getSpotifyPlaylistId(url);
  const token = await getSpotifyToken();

  const tracks = [];
  let next = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=50`;

  while (next) {
    const res = await fetch(next, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json();

    for (const item of data.items || []) {
      if (!item.track) continue;
      if (!item.track.name) continue;

      const title = item.track.name;
      const artists = item.track.artists.map((a) => a.name).join(" ");

      tracks.push({
        type: "search",
        title,
        searchText: `${title} ${artists}`,
      });
    }

    next = data.next;
  }

  return tracks;
}

async function searchYouTube(query) {
  const result = await yts(query);
  const video = result.videos?.[0];

  if (!video) {
    throw new Error("YouTubeで見つかりませんでした");
  }

  return {
    type: "youtube",
    title: video.title,
    url: video.url,
  };
}

async function getYouTubeVideo(url) {
  const info = await youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificates: true,
  });

  return {
    type: "youtube",
    title: info.title || url,
    url,
  };
}

async function getYouTubePlaylist(url) {
  const info = await youtubedl(url, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
  });

  return (info.entries || []).map((video) => ({
    type: "youtube",
    title: video.title || video.id,
    url: `https://www.youtube.com/watch?v=${video.id}`,
  }));
}

async function joinVC(message) {
  const voiceChannel = message.member?.voice?.channel;

  if (!voiceChannel) {
    message.reply("先にボイスチャンネルに入ってください。");
    return false;
  }

  textChannel = message.channel;

  if (connection && player) {
    return true;
  }

  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  player = createAudioPlayer();
  connection.subscribe(player);

  player.on(AudioPlayerStatus.Idle, () => {
    if (!isPaused) {
      playNext();
    }
  });

  player.on("error", (error) => {
    console.error("Player Error:", error);
    textChannel?.send("再生エラーが出ました。次の曲へ進みます。");
    playNext();
  });

  return true;
}

async function playSong(song) {
  try {
    let target = song;

    if (song.type === "search") {
      textChannel?.send(`検索中: ${song.searchText}`);
      target = await searchYouTube(song.searchText);
    }

    const stream = youtubedl.exec(target.url, {
      output: "-",
      format: "bestaudio/best",
      quiet: true,
      noWarnings: true,
      noCheckCertificates: true,
      addHeader: [
        "referer:youtube.com",
        "user-agent:Mozilla/5.0",
      ],
    });

    stream.stderr.on("data", (data) => {
      console.error("yt-dlp:", data.toString());
    });

    const resource = createAudioResource(stream.stdout, {
      inputType: StreamType.Arbitrary,
    });

    currentSong = target.title;
    player.play(resource);

    textChannel?.send(`再生中: ${target.title}`);
  } catch (error) {
    console.error("再生エラー:", error);
    textChannel?.send(`曲の再生に失敗しました。\n理由: ${error.message}`);
    playNext();
  }
}

function playNext() {
  if (!queue.length) {
    currentSong = null;
    textChannel?.send("キューが空になりました。");
    return;
  }

  const song = queue.shift();
  playSong(song);
}

async function resolveInput(input) {
  if (isSpotifyTrack(input)) {
    return [await getSpotifyTrack(input)];
  }

  if (isSpotifyPlaylist(input)) {
    return await getSpotifyPlaylist(input);
  }

  if (isYouTubePlaylist(input)) {
    return await getYouTubePlaylist(input);
  }

  if (isYouTubeVideo(input)) {
    return [await getYouTubeVideo(input)];
  }

  return [
    {
      type: "search",
      title: input,
      searchText: input,
    },
  ];
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (content === "!help") {
    return message.reply(`
コマンド一覧

!join
BOTをVCに接続

!play 曲名
曲名で検索して再生

!play YouTube動画URL
YouTube単体動画を再生

!play YouTubeプレイリストURL
YouTubeプレイリストを追加

!play Spotify曲URL
Spotify単体曲を検索して再生

!play SpotifyプレイリストURL
Spotifyプレイリストを追加

!skip
次の曲へ

!pause
一時停止

!resume
再開

!queue
キュー確認

!clear
キュー削除

!now
現在再生中

!stop
停止して退出
`);
  }

  if (content === "!join") {
    const joined = await joinVC(message);
    if (joined) return message.reply("ボイスチャンネルに接続しました。");
  }

  if (content.startsWith("!play ")) {
    const input = content.replace("!play ", "").trim();

    if (!input) {
      return message.reply("URLか曲名を入力してください。");
    }

    const joined = await joinVC(message);
    if (!joined) return;

    try {
      await message.reply("読み込み中...");

      const songs = await resolveInput(input);

      if (!songs.length) {
        return message.reply("曲が見つかりませんでした。");
      }

      queue.push(...songs);

      message.channel.send(`${songs.length}曲をキューに追加しました。`);

      if (!currentSong) {
        playNext();
      }
    } catch (error) {
      console.error("読み込みエラー:", error);
      message.reply(`読み込みに失敗しました。\n理由: ${error.message}`);
    }
  }

  if (content === "!skip") {
    if (!player) return message.reply("再生中の曲がありません。");
    message.reply("スキップしました。");
    player.stop();
  }

  if (content === "!pause") {
    if (!player) return message.reply("再生中の曲がありません。");
    isPaused = true;
    player.pause();
    message.reply("一時停止しました。");
  }

  if (content === "!resume") {
    if (!player) return message.reply("再生中の曲がありません。");
    isPaused = false;
    player.unpause();
    message.reply("再開しました。");
  }

  if (content === "!queue") {
    if (!queue.length) return message.reply("キューは空です。");

    const list = queue
      .slice(0, 10)
      .map((song, i) => `${i + 1}. ${song.title || song.searchText}`)
      .join("\n");

    return message.reply(`現在のキュー:\n${list}`);
  }

  if (content === "!clear") {
    queue.length = 0;
    return message.reply("キューを空にしました。");
  }

  if (content === "!now") {
    if (!currentSong) return message.reply("現在再生中の曲はありません。");
    return message.reply(`現在再生中: ${currentSong}`);
  }

  if (content === "!stop") {
    queue.length = 0;
    currentSong = null;
    isPaused = false;

    if (player) player.stop();

    if (connection) {
      connection.destroy();
    }

    connection = null;
    player = null;

    return message.reply("停止してボイスチャンネルから退出しました。");
  }
});

client.once("ready", () => {
  console.log(`${client.user.tag} でログインしました`);
});

client.login(process.env.DISCORD_TOKEN);
