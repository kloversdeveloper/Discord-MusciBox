import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
} from "@discordjs/voice";
import play from "play-dl";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const queue = [];
let connection, player, textChannel, currentSong;

// ================= VC接続 =================
async function joinVC(msg) {
  const vc = msg.member.voice.channel;
  if (!vc) return msg.reply("VC入って");

  textChannel = msg.channel;

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: vc.id,
      guildId: msg.guild.id,
      adapterCreator: msg.guild.voiceAdapterCreator,
    });

    player = createAudioPlayer();
    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => playNext());
  }
}

// ================= 再生 =================
async function playSong(song) {
  try {
    let video;

    if (song.type === "search") {
      textChannel.send(`検索中: ${song.searchText}`);
      const res = await play.search(song.searchText, { limit: 1 });
      if (!res.length) throw new Error("見つからない");
      video = res[0];
    } else {
      video = song;
    }

    const stream = await play.stream(video.url);

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
    });

    currentSong = video.title;
    player.play(resource);

    textChannel.send(`再生中: ${video.title}`);
  } catch {
    textChannel.send("再生失敗→次");
    playNext();
  }
}

function playNext() {
  if (!queue.length) {
    currentSong = null;
    textChannel.send("キュー空");
    return;
  }
  playSong(queue.shift());
}

// ================= 入力処理 =================
async function resolve(input) {
  if (input.includes("youtube")) {
    return [{ type: "youtube", title: input, url: input }];
  }

  return [{
    type: "search",
    title: input,
    searchText: input
  }];
}

// ================= コマンド =================
client.on("messageCreate", async m => {
  if (m.author.bot) return;

  const c = m.content;

  if (c === "!join") {
    await joinVC(m);
    return m.reply("接続OK");
  }

  if (c.startsWith("!play ")) {
    await joinVC(m);

    const songs = await resolve(c.slice(6));
    queue.push(...songs);

    m.channel.send(`${songs.length}曲追加`);

    if (!currentSong) playNext();
  }

  if (c === "!skip") player.stop();

  if (c === "!stop") {
    queue.length = 0;
    player.stop();
    connection.destroy();
    connection = null;
  }
});

client.once("ready", () => {
  console.log(`${client.user.tag} 起動`);
});

client.login(process.env.DISCORD_TOKEN);
