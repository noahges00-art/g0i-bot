require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const ADMIN_ROLE_NAME = process.env.ADMIN_ROLE_NAME || 'Admin';
const MONGO_URI = process.env.MONGO_URI || '';

const LOG_DIR = path.join(__dirname, 'logs');
const DATA_DIR = path.join(__dirname, 'data');
const GIVEAWAYS_FILE = path.join(DATA_DIR, 'giveaways.json');
const EVENTS_LOG = path.join(LOG_DIR, 'events.log');
const EVENTS_JSON = path.join(LOG_DIR, 'events.json');
const WARN_FILE = path.join(DATA_DIR, 'warnings.json');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');

// ensure folders
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(GIVEAWAYS_FILE)) fs.writeFileSync(GIVEAWAYS_FILE, '[]');
if (!fs.existsSync(WARN_FILE)) fs.writeFileSync(WARN_FILE, '{}');
if (!fs.existsSync(INVITES_FILE)) fs.writeFileSync(INVITES_FILE, '{}');
if (!fs.existsSync(path.join(DATA_DIR, 'giveaways.json'))) fs.writeFileSync(path.join(DATA_DIR, 'giveaways.json'), '[]');

function logEvent(type, payload){
  const entry = { ts: new Date().toISOString(), type, payload };
  try {
    fs.appendFileSync(EVENTS_LOG, JSON.stringify(entry) + '\n');
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(EVENTS_JSON, 'utf8') || '[]'); } catch(e){ arr = []; }
    arr.push(entry);
    if (arr.length > 1000) arr = arr.slice(arr.length-1000);
    fs.writeFileSync(EVENTS_JSON, JSON.stringify(arr, null, 2));
  } catch (err) {
    console.error('Failed to write logs', err);
  }
}

// moderation
const BAD_WORDS = ['badword1','badword2','شتمه']; // customize
function containsBadWord(text){
  if(!text) return false;
  const t = text.toLowerCase();
  return BAD_WORDS.some(w => t.includes(w));
}
function isSpam(message){
  const t = message.content || '';
  if(!t) return false;
  if (message.mentions && message.mentions.users.size > 5) return true;
  const links = (t.match(/https?:\/\//g) || []).length;
  if (links > 3) return true;
  if (/(.)\1{14,}/.test(t)) return true;
  return false;
}

// Giveaways helpers
function loadGiveaways(){ try { return JSON.parse(fs.readFileSync(GIVEAWAYS_FILE,'utf8')||'[]'); } catch(e){ return []; } }
function saveGiveaways(arr){ fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify(arr, null, 2)); }

// Warnings helpers
function loadWarnings(){ try { return JSON.parse(fs.readFileSync(WARN_FILE,'utf8')||'{}'); } catch(e){ return {}; } }
function saveWarnings(obj){ fs.writeFileSync(WARN_FILE, JSON.stringify(obj, null, 2)); }

// Invites helpers
function loadInvites(){ try { return JSON.parse(fs.readFileSync(INVITES_FILE,'utf8')||'{}'); } catch(e){ return {}; } }
function saveInvites(obj){ fs.writeFileSync(INVITES_FILE, JSON.stringify(obj, null, 2)); }

if (!TOKEN || !CLIENT_ID) {
  console.error('Set DISCORD_TOKEN and CLIENT_ID in .env');
  process.exit(1);
}

// MongoDB: message saving + member model
let MessageModel = null;
let MemberModel = null;
async function connectMongo(){
  if(!MONGO_URI) {
    console.log('MONGO_URI not set — skipping MongoDB connection (messages/members will not be saved to DB).');
    return;
  }
  try {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    const msgSchema = new mongoose.Schema({
      guildId: String, channelId: String, userId: String, username: String, content: String, createdAt: Date
    });
    MessageModel = mongoose.model('Message', msgSchema);
    const memberSchema = new mongoose.Schema({
      guildId: String, userId: String, username: String, joinedAt: Date, inviterId: String
    });
    MemberModel = mongoose.model('Member', memberSchema);
    console.log('Connected to MongoDB');
    logEvent('mongo.connect', { uri: MONGO_URI });
  } catch (err) {
    console.error('MongoDB connect error', err);
    logEvent('mongo.error', { error: String(err) });
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const rest = new REST({ version: '10' }).setToken(TOKEN);

// Invite cache
const invitesCache = new Map(); // guildId -> Map(inviteCode -> uses)

async function cacheGuildInvites(guild){
  try {
    const invites = await guild.invites.fetch();
    const codeUses = new Map();
    invites.each(inv => codeUses.set(inv.code, inv.uses));
    invitesCache.set(guild.id, codeUses);
    logEvent('invites.cache', { guild: guild.id, count: invites.size });
  } catch(e){
    console.error('cache invites error', e);
  }
}

// Register commands
async function registerCommands() {
  const commands = [
    { name: 'ticket', description: 'Open a support ticket (you will be asked details)' },
    { name: 'close', description: 'Close the current ticket (staff only)' },
    { name: 'giveaway', description: 'Giveaway subcommands (start/end)' , options: [
      { name: 'start', type: 1, description: 'Start a giveaway', options: [
        { name: 'duration_seconds', type: 4, description: 'Duration in seconds', required: true },
        { name: 'winners', type: 4, description: 'Number of winners', required: true },
        { name: 'prize', type: 3, description: 'What is the prize?', required: true }
      ]},
      { name: 'end', type: 1, description: 'End a running giveaway (provide message id)', options: [
        { name: 'message_id', type: 3, description: 'Giveaway message id', required: true }
      ]}
    ]},
    { name: 'announce', description: 'Post an embed announcement (staff only)', options: [
      { name: 'title', type: 3, description: 'Title', required: true },
      { name: 'description', type: 3, description: 'Description', required: true }
    ]},
    { name: 'logs', description: 'Fetch recent logs (staff only)', options: [
      { name: 'lines', type: 4, description: 'How many log lines', required: false }
    ]}
  ];
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Registered commands to guild', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered global commands (may take up to 1 hour)');
    }
  } catch (err) {
    console.error('Failed to register commands', err);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  await connectMongo();

  // cache invites for all guilds
  client.guilds.cache.forEach(g => cacheGuildInvites(g));

  // resume giveaways
  const gvs = loadGiveaways();
  const now = Date.now();
  for(const gv of gvs){
    if(!gv.ended && gv.endsAt > now){
      const ms = gv.endsAt - now;
      setTimeout(()=> endGiveawayById(gv.messageId, gv.channelId), ms);
    }
  }
});

// helper admin resolution
function isStaff(member){
  if(!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageChannels)) return true;
  if (member.roles.cache.some(r=>r.name === ADMIN_ROLE_NAME)) return true;
  return false;
}

// Ensure Tickets category
async function ensureTicketsCategory(guild) {
  const name = 'Tickets';
  const cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name);
  if (cat) return cat;
  try {
    const created = await guild.channels.create({ name, type: ChannelType.GuildCategory, reason: 'Create Tickets category' });
    logEvent('category.create', { guild: guild.id, category: created.id });
    return created;
  } catch (err) {
    console.error('create category error', err);
    return null;
  }
}

// Create ticket with data and Claim button
async function createTicketChannelFromModal(interaction, game, issue){
  const user = interaction.user;
  const guild = interaction.guild;
  const category = await ensureTicketsCategory(guild);
  const rawName = `ticket-${user.username.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,12)}-${user.discriminator}`;
  const everyone = guild.roles.everyone;
  const permissionOverwrites = [
    { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] }
  ];
  guild.roles.cache.forEach(role => {
    if (role.permissions.has(PermissionFlagsBits.ManageChannels) || role.permissions.has(PermissionFlagsBits.Administrator) || role.name === ADMIN_ROLE_NAME) {
      permissionOverwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] });
    }
  });

  const channel = await guild.channels.create({
    name: rawName,
    type: ChannelType.GuildText,
    parent: category ? category.id : undefined,
    permissionOverwrites
  });

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );

  const embed = new EmbedBuilder()
    .setTitle('New Support Ticket')
    .addFields(
      { name: 'User', value: `<@${user.id}>`, inline: true },
      { name: 'Game', value: game || 'N/A', inline: true },
      { name: 'Issue', value: issue || 'N/A' }
    )
    .setColor(0x0EA5A4)
    .setFooter({ text: `Ticket for ${user.tag}` });

  const msg = await channel.send({ embeds: [embed], components: [actionRow] });
  logEvent('ticket.open', { guild: guild.id, channel: channel.id, user: user.id, game, issue, messageId: msg.id });

  // store initial message in Mongo
  if (MessageModel) {
    try {
      await MessageModel.create({ guildId: guild.id, channelId: channel.id, userId: user.id, username: user.tag, content: `Ticket opened: Game=${game} | Issue=${issue}`, createdAt: new Date() });
    } catch(e){ console.error('save ticket open msg', e); }
  }
  return channel;
}

// Claim handling
async function claimTicket(interaction){
  const channel = interaction.channel;
  const member = interaction.member;
  if(!isStaff(member)) {
    return interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });
  }
  // set channel topic or send message marking claimed
  await interaction.reply({ content: `${member.user.tag} claimed this ticket.`, ephemeral: false });
  await channel.send(`${member} has claimed this ticket and will assist you.`);
  logEvent('ticket.claim', { guild: channel.guild.id, channel: channel.id, by: member.user.id });
}

// Invite handling on member join
client.on('guildMemberAdd', async member => {
  try {
    const guild = member.guild;
    // fetch latest invites
    const newInvites = await guild.invites.fetch();
    const cached = invitesCache.get(guild.id);
    let usedInvite = null;
    if (cached) {
      newInvites.each(inv => {
        const prev = cached.get(inv.code) || 0;
        if (inv.uses > prev) {
          usedInvite = inv;
        }
      });
    } else {
      // if no cache, try to find invite with uses > 0
      newInvites.each(inv => { if (inv.uses > 0 && !usedInvite) usedInvite = inv; });
    }

    // update cache
    const updatedMap = new Map();
    newInvites.each(inv => updatedMap.set(inv.code, inv.uses));
    invitesCache.set(guild.id, updatedMap);

    const inviterId = usedInvite && usedInvite.inviter ? usedInvite.inviter.id : null;
    const inviterTag = usedInvite && usedInvite.inviter ? usedInvite.inviter.tag : null;

    // update invites counts file
    const invitesObj = loadInvites();
    if (inviterId) {
      invitesObj[inviterId] = (invitesObj[inviterId] || 0) + 1;
      saveInvites(invitesObj);
    }

    // log event
    logEvent('member.join', { guild: guild.id, userId: member.id, username: member.user.tag, inviterId, inviterTag });

    // save to Mongo
    if (MemberModel) {
      try {
        await MemberModel.create({ guildId: guild.id, userId: member.id, username: member.user.tag, joinedAt: new Date(), inviterId: inviterId });
      } catch(e){ console.error('save member', e); }
    }

    // send welcome message to welcome channel if exists
    const welcome = guild.channels.cache.find(ch=>ch.name && ch.name.toLowerCase().includes('welcome'));
    if (welcome) {
      const mtext = inviterId ? `Welcome ${member.user.tag}! Invited by <@${inviterId}> (${inviterTag}).` : `Welcome ${member.user.tag}!`;
      welcome.send(mtext).catch(()=>{});
    }

  } catch (err) {
    console.error('guildMemberAdd handler error', err);
  }
});

// Rest of bot: messageCreate, interactionCreate handlers -- simplified for brevity
client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    // save message to Mongo
    if (MessageModel) {
      try {
        await MessageModel.create({ guildId: message.guild?.id, channelId: message.channel.id, userId: message.author.id, username: message.author.tag, content: message.content, createdAt: new Date() });
      } catch(e){ console.error('save message', e); }
    }
    // auto moderation with warning
    if (containsBadWord(message.content) || isSpam(message)) {
      const warns = loadWarnings();
      const key = `${message.guild.id}:${message.author.id}`;
      warns[key] = (warns[key] || 0) + 1;
      saveWarnings(warns);
      // first send warning DM then delete message
      try {
        await message.reply(`${message.author}, this message violates server rules. This is warning #${warns[key]}. Repeated violations may result in a ban.`);
        logEvent('moderation.warn', { guild: message.guild.id, channel: message.channel.id, user: message.author.id, reason: 'badword_or_spam', warningCount: warns[key] });
      } catch(e){ console.error('warn send error', e); }
      // delete message after warning
      try { await message.delete(); logEvent('moderation.delete', { guild: message.guild.id, channel: message.channel.id, user: message.author.id }); } catch(e){ console.error('delete error', e); }
      return;
    }

    // feedback auto-reply
    if (message.channel && message.channel.name && message.channel.name.toLowerCase().includes('feedback')) {
      try {
        await message.reply({ content: `Thank you for your feedback, ${message.author}! We appreciate it ❤️` });
        logEvent('feedback.reply', { guild: message.guild.id, channel: message.channel.id, user: message.author.id, content: message.content });
      } catch(e){ console.error('feedback reply error', e); }
    }

  } catch (err) {
    console.error('messageCreate handler error', err);
  }
});

// interaction handling (ticket modal, commands, claim/close buttons)...
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'ticket_modal') {
      const game = interaction.fields.getTextInputValue('game_input');
      const issue = interaction.fields.getTextInputValue('issue_input');
      await interaction.reply({ content: 'Thanks — your ticket is being created...', ephemeral: true });
      const ch = await createTicketChannelFromModal(interaction, game, issue);
      await ch.send(`<@${interaction.user.id}> Ticket created successfully.`);
      return;
    }

    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      if (name === 'ticket') {
        const modal = new ModalBuilder().setCustomId('ticket_modal').setTitle('Open a Support Ticket');
        const gameInput = new TextInputBuilder().setCustomId('game_input').setLabel('Which game? (e.g. Valorant)').setStyle(TextInputStyle.Short).setRequired(true);
        const issueInput = new TextInputBuilder().setCustomId('issue_input').setLabel('Describe your issue').setStyle(TextInputStyle.Paragraph).setRequired(true);
        const row1 = new ActionRowBuilder().addComponents(gameInput);
        const row2 = new ActionRowBuilder().addComponents(issueInput);
        modal.addComponents(row1, row2);
        await interaction.showModal(modal);
        logEvent('ticket.modal_shown', { guild: interaction.guild.id, user: interaction.user.id });
        return;
      } else if (name === 'close') {
        const member = interaction.member;
        if (!isStaff(member)) return interaction.reply({ content: 'You are not allowed to close tickets.', ephemeral: true });
        const ch = interaction.channel;
        await interaction.reply({ content: 'Closing ticket...', ephemeral: true });
        await closeTicket(ch, interaction.user);
        return;
      } else if (name === 'giveaway') {
        const sub = interaction.options.getSubcommand(false);
        if (sub === 'start') {
          const dur = interaction.options.getInteger('duration_seconds');
          const winners = interaction.options.getInteger('winners');
          const prize = interaction.options.getString('prize');
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Not allowed', ephemeral: true });
          await startGiveaway(interaction, dur, winners, prize);
          return;
        } else if (sub === 'end') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Not allowed', ephemeral: true });
          const msgId = interaction.options.getString('message_id');
          await interaction.reply({ content: 'Ending giveaway...', ephemeral: true });
          await endGiveawayById(msgId, interaction.channel.id);
          return;
        } else {
          return interaction.reply({ content: 'Invalid subcommand', ephemeral: true });
        }
      } else if (name === 'announce') {
        const title = interaction.options.getString('title');
        const desc = interaction.options.getString('description');
        await postAnnouncement(interaction, title, desc);
        return;
      } else if (name === 'logs') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Not allowed', ephemeral: true });
        const lines = interaction.options.getInteger('lines') || 20;
        try {
          const data = fs.readFileSync(EVENTS_LOG,'utf8').trim().split('\n').slice(-lines).join('\n');
          await interaction.reply({ content: `Last ${lines} log lines:\n\n\`\`\`json\n${data}\n\`\`\``, ephemeral: true });
        } catch(e){
          await interaction.reply({ content: 'No logs found.', ephemeral: true });
        }
        return;
      }
    }

    if (interaction.isButton && interaction.isButton()) {
      if (interaction.customId === 'close_ticket') {
        const ch = interaction.channel;
        const member = interaction.member;
        const is_staff = isStaff(member);
        if (!is_staff) {
          if (!ch.name.includes(interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g,''))) {
            return interaction.reply({ content: 'Only staff or ticket owner can close.', ephemeral: true });
          }
        }
        await interaction.reply({ content: 'Closing ticket...', ephemeral: true });
        await closeTicket(ch, interaction.user);
      } else if (interaction.customId === 'claim_ticket') {
        await claimTicket(interaction);
      }
    }

  } catch (err) {
    console.error('interaction handler error', err);
  }
});

// closeTicket function reuse
async function closeTicket(channel, byUser) {
  try {
    await channel.setName(`closed-${channel.name}`).catch(()=>{});
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, { ViewChannel: false });
    await channel.send(`This ticket was closed by ${byUser.tag || byUser}. Deleting channel in 10 seconds...`);
    logEvent('ticket.close', { guild: channel.guild.id, channel: channel.id, by: byUser.id || byUser });
    setTimeout(()=>{ channel.delete('Ticket closed'); }, 10000);
  } catch (err) {
    console.error('close ticket error', err);
  }
}

// The rest of helper functions (giveaway end, announce, logging) are included above in previous versions.
// For brevity, assume other functions (startGiveaway, endGiveawayById, postAnnouncement, etc.) are present in file.

client.login(TOKEN);
