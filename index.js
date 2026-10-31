
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const Database = require('better-sqlite3');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing Discord credentials in .env');
  process.exit(1);
}

const db = new Database('twizzle.sqlite');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  guild TEXT NOT NULL,
  user TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  banner TEXT DEFAULT '',
  created INTEGER,
  PRIMARY KEY (guild, user),
  UNIQUE (guild, handle)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT DEFAULT '',
  image TEXT DEFAULT '',
  original INTEGER,
  created INTEGER,
  deleted INTEGER DEFAULT 0,
  message_id TEXT,
  channel_id TEXT
);

CREATE TABLE IF NOT EXISTS likes (
  guild TEXT,
  user TEXT,
  post INTEGER,
  PRIMARY KEY (guild, user, post)
);

CREATE TABLE IF NOT EXISTS saves (
  guild TEXT,
  user TEXT,
  post INTEGER,
  PRIMARY KEY (guild, user, post)
);

CREATE TABLE IF NOT EXISTS follows (
  guild TEXT,
  follower TEXT,
  followed TEXT,
  PRIMARY KEY (guild, follower, followed)
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild TEXT,
  post INTEGER,
  author TEXT,
  body TEXT,
  created INTEGER
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild TEXT,
  user TEXT,
  body TEXT,
  created INTEGER
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild TEXT,
  post INTEGER,
  reporter TEXT,
  reason TEXT,
  created INTEGER
);

CREATE TABLE IF NOT EXISTS bans (
  guild TEXT,
  user TEXT,
  PRIMARY KEY (guild, user)
);

CREATE TABLE IF NOT EXISTS settings (
  guild TEXT PRIMARY KEY,
  channel TEXT
);
`);

function migrate(table, column, definition) {
  const columns = db.prepare(
    `PRAGMA table_info(${table})`
  ).all();

  if (!columns.some(c => c.name === column)) {
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
    );
  }
}

for (const [name, type] of [
  ['display_name', "TEXT DEFAULT ''"],
  ['bio', "TEXT DEFAULT ''"],
  ['avatar', "TEXT DEFAULT ''"],
  ['banner', "TEXT DEFAULT ''"],
  ['created', 'INTEGER']
]) {
  migrate('accounts', name, type);
}

for (const [name, type] of [
  ['image', "TEXT DEFAULT ''"],
  ['original', 'INTEGER'],
  ['created', 'INTEGER'],
  ['deleted', 'INTEGER DEFAULT 0'],
  ['message_id', 'TEXT'],
  ['channel_id', 'TEXT']
]) {
  migrate('posts', name, type);
}

const get = (sql, ...args) =>
  db.prepare(sql).get(...args);

const all = (sql, ...args) =>
  db.prepare(sql).all(...args);

const run = (sql, ...args) =>
  db.prepare(sql).run(...args);

function account(guild, user) {
  return get(
    'SELECT * FROM accounts WHERE guild=? AND user=?',
    guild, user
  );
}

function findPost(guild, id) {
  return get(
    `SELECT * FROM posts
     WHERE guild=? AND id=? AND COALESCE(deleted,0)=0`,
    guild, id
  );
}

function isBanned(guild, user) {
  return !!get(
    'SELECT 1 FROM bans WHERE guild=? AND user=?',
    guild, user
  );
}

function count(table, guild, postId) {
  return get(
    `SELECT COUNT(*) AS total
     FROM ${table} WHERE guild=? AND post=?`,
    guild, postId
  ).total;
}

function notify(guild, user, message) {
  run(
    `INSERT INTO notifications
     (guild,user,body,created)
     VALUES(?,?,?,?)`,
    guild, user, message, Date.now()
  );
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([*_~`>|])/g, '\\$1')
    .replace(/@/g, '@\u200b');
}

function imageURL(value) {
  const raw = String(value ?? '').trim();

  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:'
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

const emoji = {
  brand: process.env.EMOJI_BRAND || '🐦',
  post: process.env.EMOJI_POST || '📝',
  like: process.env.EMOJI_LIKE || '❤️',
  reply: process.env.EMOJI_REPLY || '💬',
  repost: process.env.EMOJI_REPOST || '🔁',
  bookmark: process.env.EMOJI_BOOKMARK || '🔖',
  profile: process.env.EMOJI_PROFILE || '👤',
  notification: process.env.EMOJI_NOTIFICATION || '🔔',
  follow: process.env.EMOJI_FOLLOW || '➕',
  trending: process.env.EMOJI_TRENDING || '🔥'
};

function textComponent(value) {
  const valueString = String(value ?? '').trim();

  return new TextDisplayBuilder().setContent(
    valueString.length
      ? valueString.slice(0, 4000)
      : '\u200b'
  );
}

function screen(title, lines = [], rows = [], images = []) {
  const container = new ContainerBuilder()
    .setAccentColor(0x171717);

  container.addTextDisplayComponents(
    textComponent(`## ${emoji.brand} ${title}`)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
  );

  for (const line of lines) {
    const content = String(line ?? '').trim();

    if (!content) continue;

    container.addTextDisplayComponents(
      textComponent(content)
    );
  }

  for (const value of images) {
    const link = imageURL(value);

    if (!link) continue;

    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(link)
      )
    );
  }

  for (const row of rows) {
    if (row) {
      container.addActionRowComponents(row);
    }
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

function privateScreen(payload) {
  return {
    ...payload,
    flags:
      MessageFlags.IsComponentsV2 |
      MessageFlags.Ephemeral
  };
}

function privateText(message) {
  return {
    content: String(message),
    flags: MessageFlags.Ephemeral
  };
}

function btn(id, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style);
}

function postScreen(guild, post) {
  const author = account(guild, post.author);

  const likes = count('likes', guild, post.id);
  const replies = count('replies', guild, post.id);

  const name = escapeText(
    author?.display_name || author?.handle || 'Unknown'
  );

  const handle = escapeText(
    author?.handle || 'unknown'
  );

  const created = Math.floor(
    (post.created || Date.now()) / 1000
  );

  const lines = [
    `**${name}** · @${handle} · <t:${created}:R>`
  ];

  if (post.original) {
    lines.push(
      `${emoji.repost} Reposted post #${post.original}`
    );
  }

  if (String(post.body || '').trim()) {
    lines.push(escapeText(post.body));
  }

  lines.push(
    `${emoji.like} ${likes} likes · ` +
    `${emoji.reply} ${replies} replies`
  );

  const actions = new ActionRowBuilder().addComponents(
    btn(`like:${post.id}`, `Like ${likes}`),
    btn(`reply:${post.id}`, 'Reply'),
    btn(`repost:${post.id}`, 'Repost'),
    btn(`save:${post.id}`, 'Save'),
    btn(`more:${post.id}`, 'More')
  );

  return screen(
    `Post #${post.id}`,
    lines,
    [actions],
    [post.image]
  );
}

function profileScreen(guild, userAccount) {
  const posts = get(
    `SELECT COUNT(*) AS total FROM posts
     WHERE guild=? AND author=? AND COALESCE(deleted,0)=0`,
    guild, userAccount.user
  ).total;

  const followers = get(
    `SELECT COUNT(*) AS total FROM follows
     WHERE guild=? AND followed=?`,
    guild, userAccount.user
  ).total;

  const following = get(
    `SELECT COUNT(*) AS total FROM follows
     WHERE guild=? AND follower=?`,
    guild, userAccount.user
  ).total;

  const joined = Math.floor(
    (userAccount.created || Date.now()) / 1000
  );

  const lines = [
    `# ${escapeText(
      userAccount.display_name || userAccount.handle
    )}`,
    `@${escapeText(userAccount.handle)}`,
    escapeText(userAccount.bio || 'No bio yet.'),
    `**${posts}** posts · ` +
    `**${followers}** followers · ` +
    `**${following}** following`,
    `Joined <t:${joined}:D>`
  ];

  return screen(
    `${emoji.profile} Profile`,
    lines,
    [],
    [userAccount.banner, userAccount.avatar]
  );
}

// Every modal input gets its own ActionRow.
// Discord permits up to five text-input rows.
function createModal(id, title, fields) {
  const modal = new ModalBuilder()
    .setCustomId(id)
    .setTitle(title);

  for (const field of fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label)
      .setStyle(
        field.paragraph
          ? TextInputStyle.Paragraph
          : TextInputStyle.Short
      )
      .setRequired(field.required !== false)
      .setMaxLength(field.max || 200);

    if (field.value) {
      input.setValue(
        String(field.value).slice(0, field.max || 200)
      );
    }

    if (field.placeholder) {
      input.setPlaceholder(field.placeholder);
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(input)
    );
  }

  return modal;
}

function modalValue(interaction, key) {
  return interaction.fields
    .getTextInputValue(key)
    .trim();
}

function validImages(avatar, banner) {
  return (
    (!avatar || !!imageURL(avatar)) &&
    (!banner || !!imageURL(banner))
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName('account-register')
    .setDescription('Create your Twizzle profile'),

  new SlashCommandBuilder()
    .setName('account-edit')
    .setDescription('Edit your Twizzle profile'),

  new SlashCommandBuilder()
    .setName('post')
    .setDescription('Create a new Twizzle post'),

  new SlashCommandBuilder()
    .setName('post-image')
    .setDescription('Post an uploaded image')
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('Image file')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('text')
        .setDescription('Caption')
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName('feed')
    .setDescription('Browse the latest posts'),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View a Twizzle profile')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Profile owner')
    ),

  new SlashCommandBuilder()
    .setName('follow')
    .setDescription('Follow a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to follow')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unfollow')
    .setDescription('Unfollow a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to unfollow')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search Twizzle posts')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('Search words')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('bookmarks')
    .setDescription('Your saved posts'),

  new SlashCommandBuilder()
    .setName('notifications')
    .setDescription('Your notifications'),

  new SlashCommandBuilder()
    .setName('trending')
    .setDescription('Trending hashtags'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Most followed accounts'),

  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Set the Twizzle feed channel')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    )
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Feed channel')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('moderate')
    .setDescription('Moderate a post')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageMessages
    )
    .addStringOption(option =>
      option.setName('action')
        .setDescription('Moderation action')
        .setRequired(true)
        .addChoices(
          { name: 'Delete post', value: 'delete' },
          { name: 'Ban author', value: 'ban' },
          { name: 'Unban author', value: 'unban' }
        )
    )
    .addIntegerOption(option =>
      option.setName('post')
        .setDescription('Post ID')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('View Twizzle commands')
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

async function publishPost(guild, post) {
  const setting = get(
    'SELECT channel FROM settings WHERE guild=?',
    guild
  );

  if (!setting?.channel) return false;

  try {
    const channel = await client.channels.fetch(
      setting.channel
    );

    if (!channel || typeof channel.send !== 'function') {
      return false;
    }

    const message = await channel.send(
      postScreen(guild, post)
    );

    run(
      `UPDATE posts SET message_id=?, channel_id=?
       WHERE guild=? AND id=?`,
      message.id,
      channel.id,
      guild,
      post.id
    );

    return true;
  } catch (error) {
    console.error('Publish failed:', error);
    return false;
  }
}

async function refreshPostMessage(guild, postId) {
  const post = findPost(guild, postId);

  if (!post?.channel_id || !post?.message_id) {
    return;
  }

  try {
    const channel = await client.channels.fetch(
      post.channel_id
    );

    const message = await channel.messages.fetch(
      post.message_id
    );

    await message.edit(postScreen(guild, post));
  } catch (error) {
    console.error('Could not refresh post:', error.message);
  }
}

client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.inGuild()) {
      if (interaction.isRepliable()) {
        await interaction.reply(
          privateText('Twizzle only works in servers.')
        );
      }
      return;
    }

    const guild = interaction.guildId;
    const user = interaction.user.id;

    // ---------- MODAL SUBMISSIONS ----------
    if (interaction.isModalSubmit()) {
      const [action, argument] =
        interaction.customId.split(':');

      if (action === 'register') {
        if (account(guild, user)) {
          return interaction.reply(
            privateText('You already have an account.')
          );
        }

        const display = modalValue(interaction, 'display');
        const handle = modalValue(interaction, 'handle')
          .toLowerCase();
        const bio = modalValue(interaction, 'bio');
        const avatar = modalValue(interaction, 'avatar');
        const banner = modalValue(interaction, 'banner');

        if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
          return interaction.reply(privateText(
            'Username must be 3–20 letters, numbers, or underscores.'
          ));
        }

        if (!validImages(avatar, banner)) {
          return interaction.reply(privateText(
            'Profile picture and banner must be valid HTTPS URLs.'
          ));
        }

        const existing = get(
          `SELECT 1 FROM accounts
           WHERE guild=? AND handle=?`,
          guild, handle
        );

        if (existing) {
          return interaction.reply(
            privateText('That username is taken.')
          );
        }

        run(
          `INSERT INTO accounts
           (guild,user,handle,display_name,bio,avatar,banner,created)
           VALUES(?,?,?,?,?,?,?,?)`,
          guild,
          user,
          handle,
          display,
          bio,
          imageURL(avatar),
          imageURL(banner),
          Date.now()
        );

        return interaction.reply(
          privateScreen(
            profileScreen(guild, account(guild, user))
          )
        );
      }

      if (action === 'edit') {
        if (!account(guild, user)) {
          return interaction.reply(
            privateText('Register first.')
          );
        }

        const display = modalValue(interaction, 'display');
        const bio = modalValue(interaction, 'bio');
        const avatar = modalValue(interaction, 'avatar');
        const banner = modalValue(interaction, 'banner');

        if (!validImages(avatar, banner)) {
          return interaction.reply(privateText(
            'Profile images must use valid HTTPS URLs.'
          ));
        }

        run(
          `UPDATE accounts
           SET display_name=?, bio=?, avatar=?, banner=?
           WHERE guild=? AND user=?`,
          display,
          bio,
          imageURL(avatar),
          imageURL(banner),
          guild,
          user
        );

        return interaction.reply(
          privateScreen(
            profileScreen(guild, account(guild, user))
          )
        );
      }

      if (action === 'compose') {
        if (!account(guild, user) || isBanned(guild, user)) {
          return interaction.reply(
            privateText('You cannot post.')
          );
        }

        const body = modalValue(interaction, 'body');
        const rawImage = modalValue(interaction, 'image');

        if (!body) {
          return interaction.reply(
            privateText('Your post cannot be empty.')
          );
        }

        if (rawImage && !imageURL(rawImage)) {
          return interaction.reply(
            privateText('Image URL must start with https://')
          );
        }

        // Acknowledge before database and network operations.
        await interaction.deferReply({
          flags: MessageFlags.Ephemeral
        });

        const result = run(
          `INSERT INTO posts
           (guild,author,body,image,created)
           VALUES(?,?,?,?,?)`,
          guild,
          user,
          body,
          imageURL(rawImage),
          Date.now()
        );

        const newPost = findPost(
          guild,
          Number(result.lastInsertRowid)
        );

        const published = await publishPost(
          guild,
          newPost
        );

        return interaction.editReply(
          `Post #${newPost.id} created! ` +
          (published
            ? 'Published to your feed.'
            : 'Use /settings to configure your feed channel.')
        );
      }

      if (action === 'reply') {
        const postId = Number(argument);
        const target = findPost(guild, postId);

        if (
          !target ||
          !account(guild, user) ||
          isBanned(guild, user)
        ) {
          return interaction.reply(
            privateText('Unable to reply.')
          );
        }

        const body = modalValue(interaction, 'body');

        if (!body) {
          return interaction.reply(
            privateText('Reply cannot be empty.')
          );
        }

        await interaction.deferReply({
          flags: MessageFlags.Ephemeral
        });

        run(
          `INSERT INTO replies
           (guild,post,author,body,created)
           VALUES(?,?,?,?,?)`,
          guild, postId, user, body, Date.now()
        );

        if (target.author !== user) {
          notify(
            guild,
            target.author,
            `@${account(guild, user).handle} replied to post #${postId}`
          );
        }

        await refreshPostMessage(guild, postId);

        return interaction.editReply(
          `Reply added to post #${postId}.`
        );
      }

      if (action === 'report') {
        const postId = Number(argument);
        const target = findPost(guild, postId);

        if (!target) {
          return interaction.reply(
            privateText('Post not found.')
          );
        }

        const reason = modalValue(
          interaction,
          'reason'
        );

        run(
          `INSERT INTO reports
           (guild,post,reporter,reason,created)
           VALUES(?,?,?,?,?)`,
          guild, postId, user, reason, Date.now()
        );

        return interaction.reply(
          privateText('Your report has been saved.')
        );
      }

      return;
    }

    // ---------- BUTTONS ----------
    if (interaction.isButton()) {
      const [action, rawId] =
        interaction.customId.split(':');

      const postId = Number(rawId);
      const target = findPost(guild, postId);

      if (!target) {
        return interaction.reply(
          privateText('This post is unavailable.')
        );
      }

      if (action === 'reply') {
        if (
          !account(guild, user) ||
          isBanned(guild, user)
        ) {
          return interaction.reply(
            privateText('Register first.')
          );
        }

        return interaction.showModal(
          createModal(
            `reply:${postId}`,
            'Reply to post',
            [
              {
                id: 'body',
                label: 'Your reply',
                paragraph: true,
                max: 500,
                placeholder: 'Write your reply...'
              }
            ]
          )
        );
      }

      if (action === 'more') {
        return interaction.reply(
          privateScreen(
            screen(
              'Post options',
              [`Post #${postId}`],
              [
                new ActionRowBuilder().addComponents(
                  btn(
                    `report:${postId}`,
                    'Report',
                    ButtonStyle.Danger
                  ),
                  btn(`view:${postId}`, 'View post')
                )
              ]
            )
          )
        );
      }

      if (action === 'report') {
        return interaction.showModal(
          createModal(
            `report:${postId}`,
            'Report post',
            [
              {
                id: 'reason',
                label: 'Reason for report',
                paragraph: true,
                max: 500
              }
            ]
          )
        );
      }

      if (action === 'view') {
        return interaction.reply(
          privateScreen(postScreen(guild, target))
        );
      }

      if (!account(guild, user)) {
        return interaction.reply(
          privateText('Use /account-register first.')
        );
      }

      if (action === 'like' || action === 'save') {
        const table = action === 'like'
          ? 'likes'
          : 'saves';

        const existing = get(
          `SELECT 1 FROM ${table}
           WHERE guild=? AND user=? AND post=?`,
          guild, user, postId
        );

        if (existing) {
          run(
            `DELETE FROM ${table}
             WHERE guild=? AND user=? AND post=?`,
            guild, user, postId
          );
        } else {
          run(
            `INSERT INTO ${table}
             (guild,user,post)
             VALUES(?,?,?)`,
            guild, user, postId
          );
        }

        if (
          action === 'like' &&
          !existing &&
          target.author !== user
        ) {
          notify(
            guild,
            target.author,
            `@${account(guild, user).handle} liked post #${postId}`
          );
        }

        // Updating the clicked message acknowledges the interaction.
        await interaction.update(
          postScreen(guild, target)
        );

        if (action === 'like') {
          await refreshPostMessage(guild, postId);
        }

        return;
      }

      if (action === 'repost') {
        if (isBanned(guild, user)) {
          return interaction.reply(
            privateText('You cannot repost.')
          );
        }

        await interaction.deferReply({
          flags: MessageFlags.Ephemeral
        });

        const result = run(
          `INSERT INTO posts
           (guild,author,body,image,original,created)
           VALUES(?,?,?,?,?,?)`,
          guild,
          user,
          target.body,
          target.image,
          postId,
          Date.now()
        );

        const repost = findPost(
          guild,
          Number(result.lastInsertRowid)
        );

        const published = await publishPost(
          guild,
          repost
        );

        if (target.author !== user) {
          notify(
            guild,
            target.author,
            `@${account(guild, user).handle} reposted #${postId}`
          );
        }

        return interaction.editReply(
          `Reposted as #${repost.id}. ` +
          (published ? 'Published!' : '')
        );
      }

      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = interaction.commandName;

    // ---------- REGISTER ----------
    if (command === 'account-register') {
      if (account(guild, user)) {
        return interaction.reply(
          privateText(
            'Already registered. Use /account-edit.'
          )
        );
      }

      return interaction.showModal(
        createModal(
          'register',
          'Create Twizzle Account',
          [
            {
              id: 'display',
              label: 'Display Name',
              max: 40,
              placeholder: 'Your public name'
            },
            {
              id: 'handle',
              label: 'Username',
              max: 20,
              placeholder: 'your_username'
            },
            {
              id: 'bio',
              label: 'Profile Bio',
              paragraph: true,
              required: false,
              max: 160,
              placeholder: 'Tell everyone about yourself'
            },
            {
              id: 'avatar',
              label: 'Profile Picture URL',
              required: false,
              max: 500,
              placeholder: 'https://example.com/avatar.png'
            },
            {
              id: 'banner',
              label: 'Profile Banner URL',
              required: false,
              max: 500,
              placeholder: 'https://example.com/banner.png'
            }
          ]
        )
      );
    }

    // ---------- EDIT ACCOUNT ----------
    if (command === 'account-edit') {
      const current = account(guild, user);

      if (!current) {
        return interaction.reply(
          privateText('Register first.')
        );
      }

      return interaction.showModal(
        createModal(
          'edit',
          'Edit Twizzle Profile',
          [
            {
              id: 'display',
              label: 'Display Name',
              max: 40,
              value: current.display_name
            },
            {
              id: 'bio',
              label: 'Bio',
              paragraph: true,
              required: false,
              max: 160,
              value: current.bio
            },
            {
              id: 'avatar',
              label: 'Profile Picture URL',
              required: false,
              max: 500,
              value: current.avatar
            },
            {
              id: 'banner',
              label: 'Profile Banner URL',
              required: false,
              max: 500,
              value: current.banner
            }
          ]
        )
      );
    }

    // ---------- POST ----------
    if (command === 'post') {
      if (
        !account(guild, user) ||
        isBanned(guild, user)
      ) {
        return interaction.reply(
          privateText(
            'Register first or check your permissions.'
          )
        );
      }

      // FIX: This is a valid two-input Discord modal.
      // Do not deferReply() before showModal().
      return interaction.showModal(
        createModal(
          'compose',
          'Create Twizzle Post',
          [
            {
              id: 'body',
              label: 'What is happening?',
              paragraph: true,
              max: 500,
              placeholder: 'Write your post...'
            },
            {
              id: 'image',
              label: 'Image URL (Optional)',
              required: false,
              max: 500,
              placeholder: 'https://example.com/image.png'
            }
          ]
        )
      );
    }

    // ---------- IMAGE POST ----------
    if (command === 'post-image') {
      if (
        !account(guild, user) ||
        isBanned(guild, user)
      ) {
        return interaction.reply(
          privateText('Register first.')
        );
      }

      const attachment =
        interaction.options.getAttachment('image');

      if (
        !attachment ||
        !attachment.contentType?.startsWith('image/')
      ) {
        return interaction.reply(
          privateText('Upload a valid image.')
        );
      }

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      const result = run(
        `INSERT INTO posts
         (guild,author,body,image,created)
         VALUES(?,?,?,?,?)`,
        guild,
        user,
        interaction.options.getString('text') || '',
        attachment.url,
        Date.now()
      );

      const created = findPost(
        guild,
        Number(result.lastInsertRowid)
      );

      const published = await publishPost(
        guild,
        created
      );

      return interaction.editReply(
        `Image post #${created.id} created. ` +
        (published
          ? 'Published!'
          : 'Set a feed channel using /settings.')
      );
    }

    // ---------- PROFILE ----------
    if (command === 'profile') {
      const selected =
        interaction.options.getUser('user') ||
        interaction.user;

      const selectedAccount = account(
        guild,
        selected.id
      );

      if (!selectedAccount) {
        return interaction.reply(
          privateText('This user has no Twizzle account.')
        );
      }

      return interaction.reply(
        profileScreen(guild, selectedAccount)
      );
    }

    // ---------- FEED / SEARCH / BOOKMARKS ----------
    if (
      command === 'feed' ||
      command === 'search' ||
      command === 'bookmarks'
    ) {
      let posts = [];

      if (command === 'feed') {
        posts = all(
          `SELECT * FROM posts
           WHERE guild=? AND COALESCE(deleted,0)=0
           ORDER BY id DESC LIMIT 5`,
          guild
        );
      }

      if (command === 'search') {
        const query = interaction.options
          .getString('query')
          .toLowerCase();

        posts = all(
          `SELECT * FROM posts
           WHERE guild=? AND COALESCE(deleted,0)=0
           ORDER BY id DESC LIMIT 500`,
          guild
        )
          .filter(p =>
            String(p.body || '')
              .toLowerCase()
              .includes(query)
          )
          .slice(0, 5);
      }

      if (command === 'bookmarks') {
        posts = all(
          `SELECT p.* FROM posts p
           JOIN saves s
             ON s.guild=p.guild AND s.post=p.id
           WHERE p.guild=? AND s.user=?
             AND COALESCE(p.deleted,0)=0
           ORDER BY p.id DESC LIMIT 5`,
          guild, user
        );
      }

      if (!posts.length) {
        return interaction.reply(
          privateText('No posts found.')
        );
      }

      await interaction.reply(
        privateText(`Showing ${posts.length} posts.`)
      );

      for (const p of posts) {
        await interaction.followUp(
          privateScreen(postScreen(guild, p))
        );
      }

      return;
    }

    // ---------- FOLLOW ----------
    if (
      command === 'follow' ||
      command === 'unfollow'
    ) {
      const target =
        interaction.options.getUser('user');

      if (
        !account(guild, user) ||
        !account(guild, target.id) ||
        target.id === user
      ) {
        return interaction.reply(
          privateText(
            'Both accounts must exist. You cannot follow yourself.'
          )
        );
      }

      if (command === 'follow') {
        const result = run(
          `INSERT OR IGNORE INTO follows
           (guild,follower,followed)
           VALUES(?,?,?)`,
          guild, user, target.id
        );

        if (result.changes) {
          notify(
            guild,
            target.id,
            `@${account(guild, user).handle} followed you`
          );
        }

        return interaction.reply(
          privateText(
            result.changes
              ? 'You are now following this account.'
              : 'Already following.'
          )
        );
      }

      run(
        `DELETE FROM follows
         WHERE guild=? AND follower=? AND followed=?`,
        guild, user, target.id
      );

      return interaction.reply(
        privateText('Unfollowed.')
      );
    }

    // ---------- NOTIFICATIONS ----------
    if (command === 'notifications') {
      const items = all(
        `SELECT body FROM notifications
         WHERE guild=? AND user=?
         ORDER BY id DESC LIMIT 12`,
        guild, user
      );

      return interaction.reply(
        privateScreen(
          screen(
            `${emoji.notification} Notifications`,
            items.length
              ? items.map(item =>
                  `• ${escapeText(item.body)}`
                )
              : ['No notifications yet.']
          )
        )
      );
    }

    // ---------- TRENDING ----------
    if (command === 'trending') {
      const recent = all(
        `SELECT body FROM posts
         WHERE guild=?
           AND COALESCE(deleted,0)=0
           AND created>?
         ORDER BY id DESC LIMIT 1000`,
        guild,
        Date.now() - 7 * 86400000
      );

      const tags = new Map();

      for (const p of recent) {
        const matches =
          String(p.body || '')
            .match(/#[\p{L}\p{N}_]+/gu) || [];

        for (const tag of matches) {
          const key = tag.toLowerCase();

          tags.set(
            key,
            (tags.get(key) || 0) + 1
          );
        }
      }

      const top = [...tags.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      return interaction.reply(
        screen(
          `${emoji.trending} Trending`,
          top.length
            ? top.map(
                ([tag, total], index) =>
                  `${index + 1}. ${escapeText(tag)} — ${total} posts`
              )
            : ['No trending hashtags yet.']
        )
      );
    }

    // ---------- LEADERBOARD ----------
    if (command === 'leaderboard') {
      const leaders = all(
        `SELECT followed, COUNT(*) AS total
         FROM follows WHERE guild=?
         GROUP BY followed
         ORDER BY total DESC LIMIT 10`,
        guild
      );

      return interaction.reply(
        screen(
          'Leaderboard',
          leaders.length
            ? leaders.map((item, index) => {
                const a = account(
                  guild,
                  item.followed
                );

                return (
                  `${index + 1}. @${escapeText(
                    a?.handle || 'unknown'
                  )} — ${item.total} followers`
                );
              })
            : ['No accounts ranked yet.']
        )
      );
    }

    // ---------- SETTINGS ----------
    if (command === 'settings') {
      if (
        !interaction.memberPermissions.has(
          PermissionFlagsBits.ManageGuild
        )
      ) {
        return interaction.reply(
          privateText('Manage Server permission required.')
        );
      }

      const channel =
        interaction.options.getChannel('channel');

      if (
        !channel ||
        typeof channel.send !== 'function'
      ) {
        return interaction.reply(
          privateText('Choose a text channel.')
        );
      }

      run(
        `INSERT INTO settings(guild,channel)
         VALUES(?,?)
         ON CONFLICT(guild)
         DO UPDATE SET channel=excluded.channel`,
        guild,
        channel.id
      );

      return interaction.reply(
        privateText(
          `Twizzle feed channel: <#${channel.id}>`
        )
      );
    }

    // ---------- MODERATION ----------
    if (command === 'moderate') {
      if (
        !interaction.memberPermissions.has(
          PermissionFlagsBits.ManageMessages
        )
      ) {
        return interaction.reply(
          privateText('Manage Messages permission required.')
        );
      }

      const postId =
        interaction.options.getInteger('post');

      const action =
        interaction.options.getString('action');

      const target = get(
        'SELECT * FROM posts WHERE guild=? AND id=?',
        guild, postId
      );

      if (!target) {
        return interaction.reply(
          privateText('Post not found.')
        );
      }

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      if (action === 'delete') {
        run(
          `UPDATE posts SET deleted=1
           WHERE guild=? AND id=?`,
          guild, postId
        );

        if (target.channel_id && target.message_id) {
          try {
            const channel =
              await client.channels.fetch(
                target.channel_id
              );

            await channel.messages.delete(
              target.message_id
            );
          } catch (error) {
            console.error(
              'Feed message deletion failed:',
              error.message
            );
          }
        }
      }

      if (action === 'ban') {
        run(
          `INSERT OR IGNORE INTO bans
           (guild,user) VALUES(?,?)`,
          guild, target.author
        );
      }

      if (action === 'unban') {
        run(
          `DELETE FROM bans
           WHERE guild=? AND user=?`,
          guild, target.author
        );
      }

      return interaction.editReply(
        `Moderation action "${action}" completed.`
      );
    }

    // ---------- HELP ----------
    if (command === 'help') {
      return interaction.reply(
        privateScreen(
          screen('Twizzle Help', [
            '**Accounts:** /account-register, /account-edit, /profile',
            '**Posting:** /post, /post-image, /feed',
            '**Social:** /follow, /unfollow, /bookmarks',
            '**Discover:** /search, /trending, /leaderboard',
            '**Activity:** /notifications',
            '**Administration:** /settings, /moderate',
            'Use post buttons to like, reply, repost, and bookmark.'
          ])
        )
      );
    }

  } catch (error) {
    console.error('\n========== TWIZZLE ERROR ==========');
    console.error(
      'Interaction:',
      interaction.commandName ||
      interaction.customId ||
      'unknown'
    );
    console.error(error.stack || error);
    console.error('===================================\n');

    if (!interaction.isRepliable()) return;

    try {
      if (interaction.deferred) {
        await interaction.editReply({
          content: 'Twizzle encountered an error. Check the console.'
        });
      } else if (interaction.replied) {
        await interaction.followUp(
          privateText(
            'Twizzle encountered an error. Check the console.'
          )
        );
      } else {
        await interaction.reply(
          privateText(
            'Twizzle encountered an error. Check the console.'
          )
        );
      }
    } catch (replyError) {
      console.error(
        'Error response failed:',
        replyError.message
      );
    }
  }
});

client.once('ready', () => {
  console.log('================================');
  console.log('TWIZZLE V4 ONLINE');
  console.log(`Logged in as ${client.user.tag}`);
  console.log('================================');
});

async function start() {
  const rest = new REST({
    version: '10'
  }).setToken(TOKEN);

  console.log('Registering Twizzle commands...');

  await rest.put(
    Routes.applicationGuildCommands(
      CLIENT_ID,
      GUILD_ID
    ),
    {
      body: commands.map(command =>
        command.toJSON()
      )
    }
  );

  console.log('Commands registered successfully.');

  await client.login(TOKEN);
}

start().catch(error => {
  console.error('Twizzle startup failed:', error);
  process.exitCode = 1;
});
