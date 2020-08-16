const tmi = require('tmi.js');
const fs = require('fs');
const store = require('./store.js');
const log = require('./log.js');
const interval = require('./deltaCountingInterval.js');
const timeConverter = require('./timeConverter.js');
const random = require('./randomWithCooldown.js');

const tokenFile = 'token';
const config = JSON.parse(fs.readFileSync('config/config.json', "utf-8"));
const questions = JSON.parse(fs.readFileSync('config/questions.json', "utf-8"));
// Might later be extended to give the ability to choose between different locales
const lang = JSON.parse(fs.readFileSync('lang/german.json', 'utf-8'));
const client = new tmi.client(buildClientOpts());
const questionDrawer = random.create(questions.length, config.questionCooldownPercent);

let currentQuestion = {};
let currentTimeout = undefined;
let questionInterval;
let running = false;

setup();

function buildClientOpts() {
  let token = fs.readFileSync(tokenFile) + "";
  return {
    "channels": [
      config.channelName
    ],
    "identity": {
      "username": config.identity.username,
      "password": token
    }
  };
}

function setup() {
  client.on('chat', onMessageHandler);
  client.on('connected', onConnectedHandler);
  client.connect().then(function () {
    log.debug(
        "All available questions:\n" + JSON.stringify(questions, null, " "));

    questionInterval = interval.create(ask, config.postQuestionIntervalInSeconds);
  });
}

function parseLocaleString(message, parameterMap) {
  for (const [key, value] of Object.entries(parameterMap)) {
    message = message.replace('${' + key + '}', value);
  }
  return message;
}

function ask() {
  if (!running) {
    log.info("Bot is not running. Skipping ask question");
    return;
  }

  currentQuestion = questions[questionDrawer.draw()];

  let message = parseLocaleString(lang.askQuestion, {
    question: currentQuestion.question,
    timeout: timeConverter.forSeconds(config.questionTimeoutInSeconds),
    answerPrefix: config.answerPrefix
  });

  client.say(config.channelName, message);
  log.info("Quiz question asked: " + message);
  log.info("Possible answers: " + JSON.stringify(currentQuestion.answers));

  if (config.questionTimeoutInSeconds > 0) {
    log.info("Question will timeout in " + config.questionTimeoutInSeconds
        + " seconds");
    currentTimeout = setTimeout(timeoutQuestion,
        config.questionTimeoutInSeconds * 1000);
  } else {
    log.debug("No timeout configured");
  }
}

function timeoutQuestion() {
  resetTimeout();
  log.info("Question timed out. Resetting it");
  client.say(config.channelName, parseLocaleString(lang.questionTimedOut, {
    question: currentQuestion.question,
    answer: currentQuestion.answers[0],
    newQuestionIn: timeConverter.forSeconds(questionInterval.getSecondsRemaining())
  }));
  currentQuestion = {};
}

function resetTimeout() {
  if (currentTimeout !== undefined) {
    log.debug("Reset timeout");
    clearTimeout(currentTimeout);
    currentTimeout = undefined;
  }
}

function onMessageHandler(target, context, message, self) {
  if (self) {
    log.debug("Message was sent from self. Ignoring it: " + message);
    return;
  }

  message = message.toLowerCase();

  let chatSender = context['display-name'].toLowerCase();
  if (resolveSpecialCommands(target, chatSender, message.trim())) {
    log.debug("Message was command. Skipping check for answer: " + message);
    return;
  }

  if (!message.startsWith(config.answerPrefix)) {
    return;
  }

  if (!running) {
    log.debug("Not reacting to message from user \"" + chatSender
        + "\" as bot is disabled: " + message);
    return;
  }

  if (Object.keys(currentQuestion).length === 0
      || currentQuestion.answers === null) {
    if (config.reactToNoQuestion) {
      client.say(target, parseLocaleString(lang.noQuestion, {
        user: chatSender
      }));
    } else {
      log.debug("Not reacting to no question as it is disabled in the config");
    }
    return;
  }

  // Remove whitespaces from chat message
  let answer = message.replace(/\s/g, '');
  answer = answer.substr(config.answerPrefix.length);

  if (currentQuestion.answers.includes(answer)) {
    log.info("User \"" + chatSender + "\" sent the correct answer");
    client.say(target, parseLocaleString(lang.correctAnswer, {
      user: chatSender,
      newQuestionIn: timeConverter.forSeconds(questionInterval.getSecondsRemaining())
    }));
    store.incrementStore(chatSender);
    resetTimeout();
    currentQuestion = {};
  } else {
    if (config.reactToWrongAnswer) {
      client.say(target, parseLocaleString(lang.wrongAnswer, {
        user: chatSender
      }));
    }
  }
}

function resolveSpecialCommands(channel, user, message) {
  if (resolveAdminCommands(channel, user, message)) {
    return true;
  }
  let comms = config.commands;
  if (comms.personalScore.toLowerCase() === message) {
    log.info("User \"" + user + "\" sent command to get own score");
    store.readForUser(user, function (data) {
      client.say(channel, parseLocaleString(lang.commandScore, {
        user: user,
        scoreNumber: data
      }));
    });
    return true;
  } else if (comms.currentQuestion.toLowerCase() === message) {
    log.info("User \"" + user + "\" sent message to get current question");
    if (Object.keys(currentQuestion).length === 0
        || currentQuestion.answers === null) {
      if (config.reactToNoQuestion) {
        client.say(target, parseLocaleString(lang.noQuestion, {
          user: chatSender
        }));
      } else {
        log.debug("Not reacting to no question as it is disabled in the config");
      }
    } else {
      client.say(channel, parseLocaleString(lang.askQuestion, {
        question: currentQuestion.question,
        answerPrefix: config.answerPrefix
      }));
    }
    return true;
  }
  return false;
}

function resolveAdminCommands(channel, user, message) {
  let comms = config.adminCommands;
  if (comms.allScores.toLowerCase() === message) {
    if (config.channelAdmin === user) {
      log.info("Admin user \"" + user + "\" sent command to get all scores");
      store.readAll(function (data) {
        _sendMultilineScores(channel, data);
      });
      return true;
    }
  } else if (comms.reset.toLowerCase() === message) {
    if (config.channelAdmin === user) {
      log.info("Admin user \"" + user + "\" sent command to reset all scores");
      store.resetStore(function (data) {
        client.say(channel, parseLocaleString(lang.commandReset, {}));
        _sendMultilineScores(channel, data);
      });
      return true;
    }
  } else if (comms.start.toLowerCase() === message) {
    if (config.channelAdmin === user) {
      log.info("Admin user \"" + user + "\" sent command to start bot");
      running = true;
      client.say(channel,
          parseLocaleString("Starting Quiz bot. Question interval: "
              + "${inter}; Next question in ${next}", {
            inter: timeConverter.forSeconds(config.postQuestionIntervalInSeconds),
            next: timeConverter.forSeconds(questionInterval.getSecondsRemaining())
          }));
      log.info("Started bot");
      return true;
    }
  } else if (comms.stop.toLowerCase() === message) {
    if (config.channelAdmin === user) {
      log.info("Admin user \"" + user + "\" sent command to stop bot");
      running = false;
      client.say(channel,
          "Stopping Bot. Will not react to anything but commands");
      log.info("Stopped bot");
      return false;
    }
  } else {
    return false;
  }
  log.warn("Invalid user tried to execute admin command. User: \""
      + user + "\"; Command: \"" + message + "\"");
  return true;
}

function _sendMultilineScores(channel, data) {
  if (Object.keys(data).length === 0) {
    client.say(channel,
        parseLocaleString(lang.commandResetNobodyHasPoints, {}));
  }
  for (const [key, value] of Object.entries(data)) {
    log.debug("User \"" + key + "\" had " + value + " points");
    client.say(channel, parseLocaleString(lang.commandScore, {
      user: key,
      scoreNumber: value.score
    }));
  }
}

function onConnectedHandler(addr, port) {
  log.info(`* Connected to ${addr}:${port}`);
  log.info("Bot running. Make sure to start it using \"" + config.adminCommands.start + "\"");
}