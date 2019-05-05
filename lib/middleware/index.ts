/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Copyright 2016 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var debug = require('debug')('watson-middleware:index');
import Botkit = require('botkit');
import AssistantV1 = require('ibm-watson/assistant/v1');
import {Storage} from 'botbuilder';
import {readContext, updateContext, postMessage, asCallback} from './utils';
import deepMerge = require('deepmerge');
import {promisify} from 'util';

export interface MiddlewareConfig {
  version: string;
  workspace_id: string;
  url?: string;
  token?: string;
  headers?: {
    [index: string]: string;
  };
  use_unauthenticated?: boolean;
  username?: string;
  password?: string;
  iam_apikey?: string;
  iam_url?: string;
  minimum_confidence?: number;
}

export interface Payload extends AssistantV1.MessageRequest {
  workspace_id: string;
}

export interface Context {
  conversation_id: string;
  system: any;
  [index: string]: any;
}

export interface ContextDelta {
  [index: string]: any;
}

export type ErrorCallback = (err: null | Error) => null;

export class WatsonMiddleware {
  private config: MiddlewareConfig;
  private conversation: AssistantV1;
  private storage: Storage;
  private minimumConfidence: number = 0.75;
  // These are initiated by Slack itself and not from the end-user. Won't send these to WCS.
  private readonly ignoreType = ['presence_change', 'reconnect_url'];

  public constructor(config: MiddlewareConfig) {
    this.config = config;
    if (config.minimum_confidence) {
      this.minimumConfidence = config.minimum_confidence;
    }
  }

  public hear(patterns: string[], message: Botkit.BotkitMessage): boolean {
    if (message.watsonData && message.watsonData.intents) {
      for (var p = 0; p < patterns.length; p++) {
        for (var i = 0; i < message.watsonData.intents.length; i++) {
          if (message.watsonData.intents[i].intent === patterns[p] &&
            message.watsonData.intents[i].confidence >= this.minimumConfidence) {
            return true;
          }
        }
      }
    }
    return false;
  }

  public before(message: Botkit.BotkitMessage, payload: Payload, callback: (err: null | Error, payload: Payload) => null): void {
    callback(null, payload);
  }

  public after(message: Botkit.BotkitMessage, response: any, callback: (err: null | Error, response: any) => null): void {
    callback(null, response);
  }

  public async sendToWatsonAsync(bot, message: Botkit.BotkitMessage, contextDelta: ContextDelta): Promise<void> {
    var before = promisify(this.before);
    var after = promisify(this.after);

    if (!this.conversation) {
      debug('Creating Assistant object with parameters: ' + JSON.stringify(this.config, null, 2));
      this.conversation = new AssistantV1(this.config);
    }

    if ((!message.text && message.type !== 'welcome') || this.ignoreType.indexOf(message.type) !== -1 || message.reply_to || message.bot_id) {
      // Ignore messages initiated by Slack. Reply with dummy output object
      message.watsonData = {
        output: {
          text: []
        }
      };
      return;
    }

    this.storage = bot.controller.storage;

    try {
      const userContext = await readContext(message.user, this.storage);

      var payload: Payload = {
        // eslint-disable-next-line @typescript-eslint/camelcase
        workspace_id: this.config.workspace_id
      };
      if (message.text) {
        // text can not contain the following characters: tab, new line, carriage return.
        var sanitizedText = message.text.replace(/[\r\n\t]/g, ' ');
        payload.input = {
          text: sanitizedText
        };
      }
      if (userContext) {
        payload.context = userContext;
      }
      if (contextDelta) {
        if (!userContext) {
          //nothing to merge, this is the first context
          payload.context = contextDelta;
        } else {
          payload.context = deepMerge(payload.context, contextDelta);
        }
      }
      if (payload.context && payload.context.workspace_id && payload.context.workspace_id.length === 36) {
        // eslint-disable-next-line @typescript-eslint/camelcase
        payload.workspace_id = payload.context.workspace_id;
      }

      const watsonRequest = await before(message, payload);
      let watsonResponse = await postMessage(this.conversation, watsonRequest);
      watsonResponse = await after(message, watsonResponse);

      message.watsonData = watsonResponse;
      await updateContext(message.user, this.storage, watsonResponse);

    } catch (error) {
      message.watsonError = error;
      debug('Error: %s', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    }
  }

  public async receiveAsync(bot: Botkit.BotWorker, message: Botkit.BotkitMessage): Promise<void> {
    return this.sendToWatsonAsync(bot, message, null);
  };

  public async interpretAsync(bot: Botkit.BotWorker, message: Botkit.BotkitMessage): Promise<void> {
    return this.sendToWatsonAsync(bot, message, null);
  };

  public async readContextAsync(user: string): Promise<Context> {
    if (!this.storage) {
      throw new Error('readContext is called before the first this.receive call');
    }
    return readContext(user, this.storage);
  };

  public async updateContextAsync(user: string, contextDelta: ContextDelta): Promise<{ context: Context | ContextDelta }> {
    if (!this.storage) {
      throw new Error('updateContext is called before the first this.receive call');
    }
    return updateContext(
      user,
      this.storage,
      {
        context: contextDelta
      }
    );
  };

  public receive(bot: Botkit.BotWorker, message: Botkit.BotkitMessage, callback: ErrorCallback): Promise<void> {
    return asCallback(this.receiveAsync(bot, message), callback);
  }

  public interpret(bot: Botkit.BotWorker, message: Botkit.BotkitMessage, callback: ErrorCallback): Promise<void> {
    return asCallback(this.interpretAsync(bot, message), callback);
  }

  public sendToWatson(bot: Botkit.BotWorker, message: Botkit.BotkitMessage, contextDelta: ContextDelta, callback: ErrorCallback): Promise<void> {
    return asCallback(this.sendToWatsonAsync(bot, message, contextDelta), callback);
  }

  public readContext(user: string, callback: ErrorCallback): Promise<void> {
    return asCallback(this.readContextAsync(user), callback);
  };

  public updateContext(user: string, contextDelta: ContextDelta, callback: ErrorCallback): Promise<void> {
    return asCallback(this.updateContextAsync(user, contextDelta), callback);
  };
}
