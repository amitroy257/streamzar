import { describe, expect, it } from 'vitest';
import { alertTemplateValues, facebookToMessage, parseIrcLine, parseKofi, parseTwitchEmotes, parseWebhookAlert, twitchToEvents, youtubeToEvents } from '../../src/shared/chatParsers';

describe('Twitch IRC', () => {
  it('parses tags, prefix, command and trailing params', () => {
    const m = parseIrcLine('@badges=broadcaster/1,subscriber/12;color=#FF0000;display-name=Cool\\sGuy;emotes=;id=abc :coolguy!coolguy@coolguy.tmi.twitch.tv PRIVMSG #chan :hello there :)');
    expect(m).toMatchObject({ prefix: 'coolguy!coolguy@coolguy.tmi.twitch.tv', command: 'PRIVMSG', params: ['#chan', 'hello there :)'] });
    expect(m?.tags['display-name']).toBe('Cool Guy');
    expect(parseIrcLine('PING :tmi.twitch.tv')).toMatchObject({ command: 'PING', params: ['tmi.twitch.tv'] });
    expect(parseIrcLine('')).toBeNull();
  });

  it('maps emote positions by code point (emoji safe)', () => {
    const text = '😀 Kappa hi Kappa';
    const em = parseTwitchEmotes('25:2-6,11-15', text);
    expect(em.map((e) => e.name)).toEqual(['Kappa', 'Kappa']);
    expect(em[0].url).toContain('/emoticons/v2/25/');
    expect(parseTwitchEmotes('25:0-99', 'short')).toEqual([]);
  });

  it('creates chat messages and bits alerts', () => {
    const m = parseIrcLine('@display-name=Fan;bits=500;color=;id=m1 :fan!fan@fan PRIVMSG #c :Cheer500 great');
    const r = twitchToEvents(m!, 1000);
    expect(r.message).toMatchObject({ id: 'm1', author: 'Fan', text: 'Cheer500 great', highlight: '500 bits' });
    expect(r.alert).toMatchObject({ type: 'bits', amount: 500, name: 'Fan', formattedAmount: '500 bits' });
  });

  it('handles /me actions', () => {
    const r = twitchToEvents(parseIrcLine(':a!a@a PRIVMSG #c :\u0001ACTION waves\u0001')!);
    expect(r.message).toMatchObject({ text: 'waves', isAction: true });
  });

  it('maps USERNOTICE subs, gifts and raids to alerts without double-counting gifts', () => {
    const sub = twitchToEvents(parseIrcLine('@msg-id=resub;display-name=Sub;msg-param-cumulative-months=7;system-msg=Sub\\ssubscribed :tmi.twitch.tv USERNOTICE #c :love it')!);
    expect(sub.alert).toMatchObject({ type: 'subscription', name: 'Sub', months: 7, message: 'love it' });
    const mystery = twitchToEvents(parseIrcLine('@msg-id=submysterygift;display-name=Gifter;msg-param-mass-gift-count=5 :tmi.twitch.tv USERNOTICE #c')!);
    expect(mystery.alert).toMatchObject({ type: 'gift_sub', count: 5 });
    const partOfMystery = twitchToEvents(parseIrcLine('@msg-id=subgift;display-name=Gifter;msg-param-community-gift-id=123 :tmi.twitch.tv USERNOTICE #c')!);
    expect(partOfMystery.alert).toBeUndefined();
    const single = twitchToEvents(parseIrcLine('@msg-id=subgift;display-name=Gifter :tmi.twitch.tv USERNOTICE #c')!);
    expect(single.alert).toMatchObject({ type: 'gift_sub', count: 1 });
    const raid = twitchToEvents(parseIrcLine('@msg-id=raid;msg-param-displayName=Raider;msg-param-viewerCount=42 :tmi.twitch.tv USERNOTICE #c')!);
    expect(raid.alert).toMatchObject({ type: 'raid', name: 'Raider', count: 42 });
  });
});

describe('YouTube', () => {
  it('maps text and Super Chat events', () => {
    const text = youtubeToEvents({ id: 'y1', snippet: { type: 'textMessageEvent', displayMessage: 'hi' }, authorDetails: { displayName: 'Viewer', isChatModerator: true } });
    expect(text.message).toMatchObject({ platform: 'youtube', author: 'Viewer', text: 'hi', badges: ['moderator'] });
    expect(text.alert).toBeUndefined();
    const sc = youtubeToEvents({
      id: 'y2',
      snippet: { type: 'superChatEvent', superChatDetails: { amountMicros: '5000000', currency: 'USD', amountDisplayString: '$5.00', userComment: 'gg' } },
      authorDetails: { displayName: 'Donor' },
    });
    expect(sc.alert).toMatchObject({ type: 'superchat', amount: 5, currency: 'USD', formattedAmount: '$5.00', message: 'gg' });
    const member = youtubeToEvents({ id: 'y3', snippet: { type: 'newSponsorEvent', newSponsorDetails: { memberLevelName: 'Gold' } }, authorDetails: { displayName: 'M' } });
    expect(member.alert?.type).toBe('membership');
    const gifts = youtubeToEvents({ id: 'y4', snippet: { type: 'membershipGiftingEvent', membershipGiftingDetails: { giftMembershipsCount: 10 } }, authorDetails: { displayName: 'G' } });
    expect(gifts.alert).toMatchObject({ type: 'gift_sub', count: 10 });
  });
});

describe('Facebook', () => {
  it('maps comments', () => {
    expect(facebookToMessage({ id: '1', message: 'hello', from: { name: 'Pat' }, created_time: '2026-01-01T10:00:00+0000' })).toMatchObject({ id: 'fb_1', author: 'Pat', text: 'hello', time: Date.parse('2026-01-01T10:00:00Z') });
    expect(facebookToMessage({ id: '2' })).toBeNull();
  });
});

describe('webhooks', () => {
  it('validates generic alerts', () => {
    expect(parseWebhookAlert({ type: 'donation', name: 'Alex', amount: 5, currency: 'usd', message: 'hi' }, 1)).toMatchObject({ type: 'donation', name: 'Alex', amount: 5, currency: 'USD', formattedAmount: '$5.00', platform: 'webhook' });
    expect(parseWebhookAlert({ type: 'hack' })).toBeNull();
    expect(parseWebhookAlert('nope')).toBeNull();
    expect(parseWebhookAlert({ type: 'follow' })).toMatchObject({ type: 'follow', name: 'Someone' });
    expect(parseWebhookAlert({ type: 'bits', name: 'b', amount: 100 })?.formattedAmount).toBe('100 bits');
  });

  it('parses Ko-fi and checks the verification token', () => {
    const data = JSON.stringify({ verification_token: 'tok', type: 'Donation', from_name: 'Kim', amount: '3.00', currency: 'EUR', message: 'coffee!', message_id: 'k1' });
    expect(parseKofi(data, 'tok')).toMatchObject({ type: 'donation', name: 'Kim', amount: 3, currency: 'EUR', message: 'coffee!' });
    expect(parseKofi(data, 'wrong')).toBeNull();
    expect(parseKofi('not json', '')).toBeNull();
    expect(parseKofi(JSON.stringify({ type: 'Subscription', from_name: 'S', amount: '5' }), '')?.type).toBe('subscription');
  });

  it('provides template values', () => {
    const v = alertTemplateValues({ id: 'a', type: 'subscription', platform: 'test', name: 'N', months: 3, time: 0 });
    expect(v.months).toBe('(3 months)');
    expect(v.name).toBe('N');
  });
});
