const Discord = require('discord.js');
const requests = require('requestify');

/*
 * Logging
 */
function epochToISO(time) {
  return new Date(time).toISOString();
}
function epochTime() {
  return new Date().getTime();
}
const LogLevel = {
  debug: {index: 0, prefix: 'DBG'},
  info: {index: 1, prefix: 'INF'},
  warn: {index: 2, prefix: 'WRN'},
  error: {index: 3, prefix: 'ERR'}
};
const logs = {
  level: 1,
  print: (level, msg) => {
    if (logs.level <= level.index)
      console.log(`${new Date().toISOString()} ${level.prefix} -- ${msg}`);
  },
  debug: msg => logs.print(LogLevel.debug, msg),
  info: msg => logs.print(LogLevel.info, msg),
  warn: msg => logs.print(LogLevel.warn, msg),
  error: msg => logs.print(LogLevel.error, msg)
};

/*
 * Database I/O
 */
const reqOptions = {
  headers: {accept: 'application/json'},
  auth: {
    username: process.env.UB_DB_USER,
    password: process.env.UB_DB_PASS
  }
};
const dbApi = {
  withQuery: (base, query) => {
    if (!query)
      return base;
    let first = true;
    for (let key in query) {
      if (query.hasOwnProperty(key)) {
        if (first) {
          first = false;
          base += '?' + key + '=' + query[key];
        } else {
          base += '&' + key + '=' + query[key];
        }
      }
    }
    return base;
  },
  getEndpoint: ept => `${process.env.UB_DB_URL}/${ept}`,
  httpGet: async url => JSON.parse((await requests.get(url, reqOptions)).body),
  httpPost: async (url, data) => JSON.parse((await requests.post(url, data, reqOptions)).body),
  httpPatch: async (url, data) => JSON.parse((await requests.request(url, Object.assign(reqOptions, {method: 'PATCH', body: data}))).body),
  httpDelete: url => requests.delete(url, reqOptions)
};
const dbBans = { // TODO Listen to a webhook in order to ban stuff and log to a channel in a server
  list: query => dbApi.httpGet(dbApi.withQuery(dbApi.getEndpoint('bans'), query)),
  put: row => dbApi.httpPost(dbApi.getEndpoint('bans'), row),
  update: (index, props) => dbApi.httpPatch(dbApi.getEndpoint(`bans/${index}`), props),
  remove: index => dbApi.httpDelete(dbApi.getEndpoint(`bans/${index}`))
};
const dbGuilds = {
  list: query => dbApi.httpGet(dbApi.withQuery(dbApi.getEndpoint('guilds'), query)),
  put: row => dbApi.httpPost(dbApi.getEndpoint('guilds'), row),
  update: (index, props) => dbApi.httpPatch(dbApi.getEndpoint(`guilds/${index}`), props),
  remove: index => dbApi.httpDelete(dbApi.getEndpoint(`guilds/${index}`))
};
const dbUsers = {
  list: query => dbApi.httpGet(dbApi.withQuery(dbApi.getEndpoint('users'), query)),
  put: row => dbApi.httpPost(dbApi.getEndpoint('users'), row),
  update: (index, props) => dbApi.httpPatch(dbApi.getEndpoint(`users/${index}`), props),
  remove: index => dbApi.httpDelete(dbApi.getEndpoint(`users/${index}`))
};
function buildQuery(entries) {
  let query = {};
  for (let entry of entries) {
    let split = entry.indexOf('=');
    if (split === -1)
      return null;
    query[entry.substring(0, split)] = entry.substring(split + 1);
  }
  return query;
}

/*
 * Configuration
 */
async function hasPermissionLevel(id, level) {
  let user = (await dbUsers.list({user: id}))[0];
  return !!user && user.perms >= level;
}

const strings = { // TODO Move all lang strings here
  error: {
    noPerms: 'You can\'t do that!',
    noQuery: 'Query parameters must be provided in `key=value` pairs!',
    noImpl: 'Not implemented!',
    notInGuild: 'This command is only usable in a server!',
    unbannable: 'You cannot ban this user!'
  }
};

const banReasons = [
  'spam', 'powerabuse', 'threats', 'harassment', 'hate', 'malware', 'phishing',
  'vulgarity', 'banevasion', 'impersonation', 'advertising'
];
const defaultBanRules = 'verified=true';

const entryFormat = {
  formatBan: function(r) {
    return `\`\`\`1c
User      | ${r.user}
Reason    | ${r.reason}
Timestamp | ${epochToISO(r.timestamp)}
Source    | ${r.source}
Verified  | ${r.verified ? 'Yes' : 'No'}
Evidence  | ${r.evidence}
\`\`\``;
  }
};

/*
 * Ban rules magic
 */
class PredicateArray extends Array {
  test(obj) {
    if (this.length === 0)
      return false;
    for (let predicate of this) {
      if (!predicate(obj))
        return false;
    }
    return true;
  }
  anyMatch(arr, gid) {
    if (this.length === 0)
      return false;
    for (let obj of arr) {
      if (obj.source === gid || this.test(obj))
        return true;
    }
    return false;
  }
}
function parseBanRules(rules) {
  let predicates = new PredicateArray();
  for (let rule of rules) {
    let split = rule.indexOf('=');
    if (!split)
      return 'Ban rules must be `key=value` pairs!';
    let key = rule.substring(0, split), value = rule.substring(split + 1);
    switch (key) {
      case 'all':
        if (value === 'true')
          predicates.push(b => true);
        else if (value !== 'false')
          return '`all` must be `true` or `false`!';
        break;
      case 'verified':
        if (value === 'true')
          predicates.push(b => b.verified);
        else if (value === 'false')
          predicates.push(b => !b.verified);
        else
          return '`verified` must be `true` or `false`!';
        break;
      case 'reason':
        let reasons = [];
        for (let reason of value.split(/|/g).map(s => s.trim())) {
          if (banReasons.indexOf(reason) === -1)
            return '`reason` must be a `|`-separated list of valid ban reasons! Try `./reasons`.';
          reasons.push(reason);
        }
        predicates.push(b => reasons.indexOf(b.reason) !== -1);
        break;
      case 'source':
        value = value.split(/|/g).map(s => s.trim());
        predicates.push(b => value.indexOf(b.source) !== -1);
        break;
      default:
        return 'Invalid ban rule! Valid rules are: `all`, `verified`, `reason`, `source`';
    }
  }
  return predicates;
}
function parseBanRuleString(ruleString) {
  return parseBanRules(ruleString.split(/,/g).map(s => s.trim()));
}
const guildCache = new Map();
const banRuleCache = new Map();
function updateBans(user) {
  dbBans.list({user: user}).then(bans => {
    for (let guild of bot.guilds.values()) {
      if (!(guildCache.has(guild.id) && guildCache.get(guild.id).blacklisted)) {
        let banRules = banRuleCache.get(guild.id) || parseBanRules([defaultBanRules]);
        if (banRules.anyMatch(bans, guild.id))
          guild.ban(user).catch(() => {});
        else
          guild.unban(user).catch(() => {});
      }
    }
  });
}
function updateGuildBans(guild) {
  if (!(guildCache.has(guild.id) && guildCache.get(guild.id).blacklisted)) {
    let banRules = banRuleCache.get(guild.id) || parseBanRules([defaultBanRules]);
    guild.fetchBans().then(guildBans => {
      guildBans = guildBans.map(b => b.user);
      dbBans.list().then(bans => {
        let userMap = new Map();
        for (let ban of bans) {
          if (userMap.has(ban.user))
            userMap.get(ban.user).push(ban);
          else
            userMap.set(ban.user, [ban]);
        }
        for (let entry of userMap.entries()) {
          if (banRules.anyMatch(entry.value, guild.id)) {
            if (guildBans.indexOf(user) === -1)
              guild.ban(user).catch(() => {});
          } else {
            if (guildBans.indexOf(user) !== -1)
              guild.unban(user).catch(() => {});
          }
        }
      });
    });
  }
}
async function canBanUser(user) {
  return user.id !== bot.user.id && !(await hasPermissionLevel(user.id, 1));
}

/*
 * Command handling
 */
class ArgParser {
  constructor(args) {
    this.args = args;
    this.pos = 0;
  }
  next() {
    return this.args[this.pos++];
  }
  hasNext() {
    return this.pos < this.args.length;
  }
  back() {
    this.pos--;
    return null;
  }
}
const flakePattern = /\d+/;
const userPattern = /<@(\d+)>/;
const channelPattern = /<#(\d+)>/;
const tokenTypes = {
  str: {name: 'string', func: async (ap, bot) => ap.hasNext() ? ap.next() : null},
  int: {
    name: 'integer', func: async (ap, bot) => {
      let parsed = parseInt(ap.next(), 10);
      return isNaN(parsed) ? ap.back() : parsed;
    }
  },
  float: {
    name: 'float', func: async (ap, bot) => {
      let parsed = parseFloat(ap.next());
      return isNaN(parsed) ? ap.back() : parsed;
    }
  },
  bool: {
    name: 'boolean', func: async (ap, bot) => {
      switch (ap.next().toLowerCase()) {
        case 'true':
        case 'yes':
        case 'on':
        case 'enable':
        case 'enabled':
          return true;
        case 'false':
        case 'no':
        case 'off':
        case 'disable':
        case 'disabled':
          return false;
        default:
          return ap.back();
      }
    }
  },
  id: {
    name: 'snowflake', func: async (ap, bot) => {
      let matches = flakePattern.exec(ap.next());
      return !matches ? ap.back() : matches[0];
    }
  },
  user: {
    name: 'user', func: async (ap, bot) => {
      let matches = userPattern.exec(ap.next());
      if (!matches)
        matches = [null, ap.args[ap.pos - 1]];
      try {
        return await bot.fetchUser(matches[1]);
      } catch (e) {
        return ap.back();
      }
    }
  },
  channel: {
    name: 'channel', func: async (ap, bot) => {
      let matches = channelPattern.exec(ap.next());
      if (!matches)
        matches = [null, ap.args[ap.pos - 1]];
      let channel = bot.channels[matches[1]];
      if (!channel)
        return ap.back();
    }
  }
};
class Command {
  constructor(argTypes, usage, desc, executor) {
    this.argTypes = [];
    this.usage = usage;
    this.desc = desc;
    if (!!argTypes) {
      argTypes.split(/,/g).map(t => t.trim()).forEach(t => {
        if (t.endsWith('?')) {
          this.argTypes.push(true);
          this.argTypes.push(tokenTypes[t.substring(0, t.length - 1)]);
          if (!this.argTypes[this.argTypes.length - 1])
            logs.error(`Unknown token type ${t}`)
        } else if (t.endsWith('*')) {
          this.argTypes.push(false);
          this.argTypes.push(tokenTypes[t.substring(0, t.length - 1)]);
          if (!this.argTypes[this.argTypes.length - 1])
            logs.error(`Unknown token type ${t}`);
        } else {
          this.argTypes.push(tokenTypes[t]);
          if (!this.argTypes[this.argTypes.length - 1])
            logs.error(`Unknown token type ${t}`)
        }
      });
    }
    this.executor = executor;
  }
  async execute(msg, args, bot) {
    logs.info(`${msg.author.id}: ${msg.content}`);
    let parser = new ArgParser(args);
    let parsed = [];
    let optional = false;
    for (let i = 0; i < this.argTypes.length; i++) {
      if (this.argTypes[i] === true) {
        optional = true;
      } else if (this.argTypes[i] === false) {
        let subParsed = [], arg = null;
        while (parser.hasNext() && (arg = await this.argTypes[i + 1].func(parser, bot)) !== null)
          subParsed.push(arg);
        parsed.push(subParsed);
        i++;
      } else {
        let arg = await this.argTypes[i].func(parser, bot);
        if (arg === null && !optional) {
          logs.info(`${msg.author.id} evoked invalid syntax error`);
          msg.reply(`Invalid syntax: expected ${this.argTypes[i].name} at position ${parsed.length + 1}`);
          return;
        }
        parsed.push(arg);
        optional = false;
      }
    }
    if (parser.hasNext()) {
      logs.info(`${msg.author.id} evoked invalid syntax error`);
      msg.reply('Invalid syntax: too many arguments');
    } else {
      let reply = null;
      try {
        reply = await this.executor(msg, parsed);
      } catch (e) {
        reply = `Command raised error: \`${e.message}\``;
        logs.warn(e.stack);
      }
      if (!!reply)
        msg.reply(reply);
    }
  }
}
const commands = {
  // Bot administration

  'invite': new Command(null, null, 'Generates a bot invite link.',
    async (msg, args) => await bot.generateInvite()),

  'eval': new Command('str*', '<script>', 'Evaluates some JS.',
    async (msg, args) => {
      if (await hasPermissionLevel(msg.author.id, 4)) {
        let result = null;
        try {
          result = eval(args[0].join(' '));
        } catch (e) {
          return `\`${e.message}\``;
        }
        if (result !== undefined && result !== null)
          return `\`${result.toString()}\``;
        else
          return 'No result.';
      } else {
        return strings.error.noPerms;
      }
    }),

  'halt': new Command(null, null, 'Kills the bot.',
    async (msg, args) => {
      if (await hasPermissionLevel(msg.author.id, 4)) {
        function destroy() {
          bot.destroy().then(() => process.exit(0));
        }
        msg.reply('Halting!').then(destroy, destroy);
      } else {
        return strings.error.noPerms;
      }
    }),

  'blacklist': new Command('id', '<guildId>', 'Blacklists a guild.',
    async (msg, args) => {
      if (await hasPermissionLevel(msg.author.id, 3)) {
        let result = (await dbGuilds.list({guild: args[0], include: 'blacklisted'}))[0];
        if (!!result) {
          if (result.blacklisted) {
            return 'Guild is already blacklisted!';
          } else {
            dbGuilds.update(result.id, {blacklisted: true});
            guildCache.get(result.guild).blacklisted = true;
            return 'Registered on blacklist.'
          }
        } else {
          let record = {guild: args[0], blacklisted: true, banrules: defaultBanRules};
          guildCache.set(args[0], record);
          banRuleCache.set(args[0], parseBanRuleString(record.banrules));
          dbGuilds.put(record);
          return 'Registered on blacklist.'
        }
      } else {
        return strings.error.noPerms;
      }
    }),

  'unblacklist': new Command('id', '<guildId>', 'Removes a guild from the blacklist.',
    async (msg, args) => {
      if (await hasPermissionLevel(msg.author.id, 3)) {
        let result = (await dbGuilds.list({guild: args[0], include: 'blacklisted'}))[0];
        if (!result || !result.blacklisted) {
          return 'Guild is not blacklisted!';
        } else {
          dbGuilds.update(result.id, {blacklisted: false});
          guildCache.get(result.guild).blacklisted = false;
          return 'Removed from blacklist.'
        }
      } else {
        return strings.error.noPerms;
      }
    }),

  'setrank': new Command('user, int', '<user> <permLevel>', 'Sets a user\'s administrative permission level.',
    async (msg, args) => {
      if (await hasPermissionLevel(msg.author.id, 4)) {
        if (args[1] > 4 || args[1] < 0) {
          return 'Invalid permission level!';
        } else {
          let result = (await dbUsers.list({user: args[0].id}))[0];
          if (args[1] === 0) {
            if (!result)
              return 'User already has no permissions!';
            dbUsers.remove(result.id);
            return 'Cleared user permissions.';
          } else {
            if (!!result) {
              if (result.perms === args[1])
                return 'User is already at that permission level!';
              dbUsers.update(result.id, {perms: args[1]});
            } else {
              dbUsers.put({user: args[0].id, perms: args[1]});
            }
            return 'Updated user permissions.';
          }
        }
      } else {
        return strings.error.noPerms;
      }
    }),

  // DB administration

  'verify': new Command('user, id', '<user> <guildId>', 'Verifies a ban.',
    async (msg, args) => {
      if (await hasPermissionLevel(msg.author.id, 3)) {
        let result = (await dbBans.list({user: args[0].id, source: args[1]}))[0];
        if (!result)
          return 'User is not locally banned in guild!';
        if (result.verified)
          return 'Ban is already verified!';
        dbBans.update(result.id, {verified: true});
        logs.info(`${msg.author.id} verified ${args[1]}:${args[0].id}`);
        updateBans(result.user);
        return 'Ban verified. \uD83D\uDD28';
      } else {
        return strings.error.noPerms;
      }
    }),

  'unverify': new Command('user, id', '<user> <guildId>', 'Unverifies a ban.',
    async (msg, args) => {
      if (await hasPermissionLevel(msg.author.id, 3)) {
        let result = (await dbBans.list({user: args[0].id, source: args[1]}))[0];
        if (!result)
          return 'User is not locally banned in guild!';
        if (!result.verified)
          return 'Ban is not verified!';
        dbBans.update(result.id, {verified: true});
        logs.info(`${msg.author.id} unverified ${args[1]}:${args[0].id}`);
        updateBans(result.user);
        return 'Ban unverified.';
      } else {
        return strings.error.noPerms;
      }
    }),

  'drop': new Command('user, id', '<user> <guildId>', 'Drops a local ban.',
    async (msg, args) => {
      if (await hasPermissionLevel(msg.author.id, 3)) {
        let result = (await dbBans.list({user: args[0].id, source: args[1]}))[0];
        if (!result)
          return 'User is not locally banned in guild!';
        dbBans.remove(result.id);
        logs.info(`${msg.author.id} dropped ban ${args[1]}:${args[0].id}`);
        updateBans(result.user);
        return 'Ban dropped.';
      } else {
        return strings.error.noPerms;
      }
    }),

  'recache': new Command(null, null, 'Flushes the cached server data and rebuilds it.',
    async (msg, args) => {
      if (await hasPermissionLevel(msg.author.id, 4)) {
        dbGuilds.list().then(r => r.forEach(g => {
          guildCache.set(g.guild, g);
          banRuleCache.set(g.guild, parseBanRuleString(g.banrules));
        }));
        return 'Cache flushed.'
      } else {
        return strings.error.noPerms;
      }
    }),

  // Server administration

  'ban': new Command('user, str, str*', '<user> <reason> [evidence]', 'Locally bans a user.',
    async (msg, args) => {
      if (!!msg.guild) {
        if (msg.member.hasPermission('BAN_MEMBERS', false, true, true)) {
          if (await canBanUser(args[0])) {
            let result = (await dbBans.list({user: args[0].id, source: msg.guild.id}))[0];
            if (!!result)
              return `User was already banned at ${epochToISO(result.timestamp)} for ${result.reason}!`;
            if (banReasons.indexOf(args[1]) === -1)
              return 'Invalid ban reason! Try `./reasons`.';
            dbBans.put({
              user: args[0].id,
              timestamp: epochTime(),
              reason: args[1],
              source: msg.guild.id,
              evidence: args[2].length !== 0 ? args[2].join(' ') : 'None provided',
              verified: await hasPermissionLevel(msg.author.id, 3)
            });
            updateBans(args[0].id);
            return 'User was banned. \uD83D\uDC4B';
          } else {
            return strings.error.unbannable;
          }
        } else {
          return strings.error.noPerms;
        }
      } else {
        return strings.error.notInGuild;
      }
    }),

  'unban': new Command('user', '<user>', 'Reverts a local ban.',
    async (msg, args) => {
      if (!!msg.guild) {
        if (msg.member.hasPermission('BAN_MEMBERS')) {
          let result = (await dbBans.list({user: args[0].id, source: msg.guild.id}))[0];
          if (!result)
            return 'User is not locally banned!';
          dbBans.remove(result.id);
          updateBans(args[0].id);
          return 'User was unbanned.';
        } else {
          return strings.error.noPerms;
        }
      } else {
        return strings.error.notInGuild
      }
    }),

  'banrules': new Command(null, null, 'Lists the current ban rules active on a server.',
    async (msg, args) => {
      if (!!msg.guild) {
        if (msg.member.hasPermission('MANAGE_GUILD')) {
          let result = (await dbGuilds.list({guild: msg.guild.id}))[0];
          if (!!result && !!result.banrules && !!result.banrules.trim())
            return `Ban rules: \`${result.banrules}\``;
          else
            return `Ban rules: \`${defaultBanRules}\``;
        } else {
          return strings.error.noPerms;
        }
      } else {
        return strings.error.notInGuild;
      }
    }),

  'setbanrules': new Command('str*', '<rule> [rule]...', 'Modifies a server\'s active ban rules.',
    async (msg, args) => {
      if (!!msg.guild) {
        if (msg.member.hasPermission('MANAGE_GUILD')) {
          let predicate = parseBanRules(args[0]);
          if ((typeof predicate) === 'string')
            return predicate;
          let joined = args[0].join(', ');
          let result = (await dbGuilds.list({guild: msg.guild.id}))[0];
          if (!!result) {
            dbGuilds.update(result.id, {banrules: joined});
            guildCache.get(result.guild).banrules = joined;
            banRuleCache.set(result.guild, predicate);
          } else {
            let record = {guild: msg.guild.id, blacklisted: false, banrules: joined};
            dbGuilds.put(record);
            guildCache.set(msg.guild.id, record);
            banRuleCache.set(msg.guild.id, predicate);
          }
          updateGuildBans(msg.guild);
          return !!joined ? 'Updated ban rules.' : 'Cleared ban rules.';
        } else {
          return strings.error.noPerms;
        }
      } else {
        return strings.error.notInGuild;
      }
    }),

  // DB access

  'lookup': new Command('str*', '<key=value> [key=value]...', 'Queries the ban database.',
    async (msg, args) => {
      if (args[0].length === 0)
        return strings.error.noQuery;
      let query = buildQuery(args[0]);
      if (!query)
        return strings.error.noQuery;
      let results = await dbBans.list(query);
      if (results.length === 0)
        return 'No results.';
      if (results.length > 3)
        return 'Too many results; try `limit=3`.';
      return results
        .map(r => entryFormat.formatBan(r))
        .join('\n');
    }),

  // Utility

  'user': new Command('id?', '[user]', 'Looks up a user by their ID.',
    async (msg, args) => {
      if (!!args[0]) {
        console.log(args[0]);
        bot.fetchUser(args[0]).then(
          u => msg.reply(`**${u.username}**#${u.discriminator}`),
          e => {
            if (e.message === 'Unknown User')
              msg.reply('Could not find user by that ID!');
            else
              throw e;
          });
      } else {
        return `**${msg.author.username}**#${msg.author.discriminator}`;
      }
    }),

  'reasons': new Command(null, null, 'Lists valid ban reasons.',
    (msg, args) => `**Valid ban reasons:** ${banReasons.join(', ')}`),

  'help': new Command(null, null, 'Lists available commands.',
    async (msg, args) => {
      let list = [];
      for (let name in commands) {
        if (commands.hasOwnProperty(name)) {
          let usage = name;
          if (!!commands[name].usage)
            usage += ' ' + commands[name].usage;
          list.push(`./${usage} | ${commands[name].desc}`);
        }
      }
      list.sort();
      msg.author.createDM().then(dm => dm.send(`**__Available Commands__**\n\`\`\`1c\n${list.join('\n')}\n\`\`\``));
      return !!msg.guild ? 'Sent documentation in DMs.' : null;
    })
};

/*
 * Bot init
 */
const bot = new Discord.Client();
bot.on('ready', () => {
  logs.info('Logged in');
  dbGuilds.list().then(r => r.forEach(g => {
    guildCache.set(g.guild, g);
    banRuleCache.set(g.guild, parseBanRuleString(g.banrules));
  }));
});
bot.on('message', async msg => {
  if (!!msg.content && msg.content.startsWith('./')) {
    let parts = msg.content.split(/\s+/g);
    let command = commands[parts[0].substring(2).toLowerCase()];
    if (!!command) {
      if (!!msg.guild && guildCache.has(msg.guild.id)) {
        if (!guildCache.get(msg.guild.id).blacklisted)
          command.execute(msg, parts.slice(1), bot);
        else
          msg.reply('a server has been blacklisted. Contact an administrator for more information.');
      } else {
        command.execute(msg, parts.slice(1), bot);
      }
    }
  }
});
bot.on('guildCreate', guild => {
  logs.info(`Joined guild ${guild.id} ${guild.name}`);
  updateGuildBans(guild);
});

bot.login(process.env.UB_TOKEN).catch(logs.error);
