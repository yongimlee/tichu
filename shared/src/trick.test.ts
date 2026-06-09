import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardPoints, type Card, type Suit } from './cards';
import { giveDragon, pass, playCards, type GameState } from './game';
import type { Seat } from './room';

function c(rank: number, suit: Suit = 'jade'): Card {
  return { kind: 'suit', suit, rank, id: `${suit}-${rank}` };
}
const DOG: Card = { kind: 'special', name: 'dog', id: 'dog' };
const DRAGON: Card = { kind: 'special', name: 'dragon', id: 'dragon' };

/** Build a GameState already in the playing phase with explicit hands. */
function playing(hands: Card[][], turn: Seat = 0): GameState {
  return {
    phase: 'playing',
    players: hands.map((hand, i) => ({
      seat: i as Seat,
      hand,
      grandTichu: false,
      tichu: false,
      decidedGrandTichu: true,
      hasPlayed: false,
      exchange: null,
    })),
    undealt: [],
    turn,
    leader: turn,
    trick: { plays: [], top: null, owner: null },
    wish: null,
    captured: [[], [], [], []],
    finished: [],
    pendingDragon: null,
  };
}

const sum = (cards: Card[]) => cards.reduce((t, card) => t + cardPoints(card), 0);

test('a trick is won by the last to play after everyone passes', () => {
  const s = playing([
    [c(5), c(2)],
    [c(7), c(2, 'star')],
    [c(9), c(3)],
    [c(11), c(4)],
  ]);
  playCards(s, 0, ['jade-5']);
  playCards(s, 1, ['jade-7']);
  playCards(s, 2, ['jade-9']);
  playCards(s, 3, ['jade-11']);
  pass(s, 0);
  pass(s, 1);
  pass(s, 2);

  assert.equal(s.trick.top, null, 'trick is cleared');
  assert.equal(s.turn, 3, 'winner leads next');
  assert.equal(s.captured[3].length, 4);
  assert.equal(sum(s.captured[3]), 5, 'the 5 is worth 5 points');
});

test('the Dog hands the lead to the partner', () => {
  const s = playing([[DOG, c(2)], [c(3)], [c(4)], [c(5)]]);
  playCards(s, 0, ['dog']);
  assert.equal(s.trick.top, null);
  assert.equal(s.turn, 2, 'partner now leads');
  assert.deepEqual(s.players[0].hand.map((x) => x.id), ['jade-2']);
  // The Dog leaves no card on the table, so it flags a one-shot handoff event...
  assert.deepEqual(s.announce, { kind: 'dog', from: 0, to: 2 });
  // ...which is consumed by the partner's next move.
  playCards(s, 2, ['jade-4']);
  assert.equal(s.announce, null);
});

test('a bomb flags a one-shot announce naming the bomber and level', () => {
  const four7 = [c(7, 'jade'), c(7, 'sword'), c(7, 'pagoda'), c(7, 'star')];
  // Seat 0 leads a single; seat 1 drops a four-of-a-kind bomb on it.
  const s = playing([[c(9)], four7, [c(4)], [c(5)]], 0);
  playCards(s, 0, ['jade-9']);
  playCards(s, 1, ['jade-7', 'sword-7', 'pagoda-7', 'star-7']);
  assert.deepEqual(s.announce, { kind: 'bomb', from: 1, level: 1 });
  // The announce must ride exactly one snapshot: a following pass clears it, so it
  // doesn't re-fire the client visual on every pass after the bomb.
  pass(s, 2);
  assert.equal(s.announce, null);
});

test('a Dragon-won trick is given to a chosen opponent', () => {
  const s = playing([[DRAGON, c(2)], [c(3)], [c(4)], [c(5)]]);
  playCards(s, 0, ['dragon']);
  pass(s, 1);
  pass(s, 2);
  pass(s, 3);

  assert.equal(s.pendingDragon?.winner, 0);
  assert.equal(s.turn, null, 'play is paused until the gift is chosen');
  assert.throws(() => giveDragon(s, 0, 2), /상대 팀/); // partner is illegal
  giveDragon(s, 0, 1);
  assert.ok(s.captured[1].some((x) => x.kind === 'special' && x.name === 'dragon'));
  assert.equal(s.turn, 0, 'the winner leads next');
});

test('a bomb beats a normal combination out of rank order', () => {
  const s = playing([
    [c(13)],
    [c(7), c(7, 'star'), c(7, 'sword'), c(7, 'pagoda'), c(2)],
    [c(3)],
    [c(4)],
  ]);
  playCards(s, 0, ['jade-13']); // lead with the King
  playCards(s, 1, ['jade-7', 'star-7', 'sword-7', 'pagoda-7']); // four-of-a-kind bomb
  assert.equal(s.trick.owner, 1);
  assert.equal(s.trick.top?.bombLevel, 1);
});

test('a double victory (both partners out) ends the hand immediately', () => {
  const s = playing([[c(2)], [c(4)], [c(3)], [c(5)]]);
  playCards(s, 0, ['jade-2']); // seat 0 goes out
  pass(s, 1);
  playCards(s, 2, ['jade-3']); // seat 2 (partner) goes out -> double victory

  assert.equal(s.phase, 'scoring');
  assert.deepEqual(s.finished, [0, 2]);
});

test('a bomb can be played out of turn to interrupt a trick', () => {
  const s = playing([
    [c(5), c(2)],
    [c(7), c(3)],
    [c(9), c(4)],
    [c(13, 'jade'), c(13, 'star'), c(13, 'sword'), c(13, 'pagoda'), c(6, 'sword')],
  ]);
  playCards(s, 0, ['jade-5']); // seat 0 leads, it is now seat 1's turn
  assert.equal(s.turn, 1);

  // Seat 2 may not play a normal card out of turn…
  assert.throws(() => playCards(s, 2, ['jade-9']), /폭탄/);

  // …but seat 3 may drop a bomb out of turn.
  playCards(s, 3, ['jade-13', 'star-13', 'sword-13', 'pagoda-13']);
  assert.equal(s.trick.owner, 3);
  assert.equal(s.trick.top?.bombLevel, 1);
  assert.equal(s.turn, 0, 'play resumes clockwise from the bomber');
});

test('a bomb cannot interrupt when there is no trick in progress', () => {
  const s = playing([
    [c(2)],
    [c(13, 'jade'), c(13, 'star'), c(13, 'sword'), c(13, 'pagoda')],
    [c(4)],
    [c(5)],
  ]);
  // Trick is empty and it is seat 0's turn; seat 1 cannot bomb the empty table.
  assert.throws(() => playCards(s, 1, ['jade-13', 'star-13', 'sword-13', 'pagoda-13']), /끼어들/);
});

test('the Mahjong wish is recorded and cleared when the rank is played', () => {
  const MAHJONG: Card = { kind: 'special', name: 'mahjong', id: 'mahjong' };
  const s = playing([[MAHJONG, c(2)], [c(8)], [c(9)], [c(8, 'star')]]);
  playCards(s, 0, ['mahjong'], { wish: 8 });
  assert.equal(s.wish, 8);
  playCards(s, 1, ['jade-8']); // fulfils the wish
  assert.equal(s.wish, null);
});

test('a trick whose winner just went out is still awarded to them and closes', () => {
  // seat 0 leads its last card (out), seat 1 beats it with its last card (out),
  // then seats 2 & 3 pass. The trick must close and go to seat 1 (the winner),
  // with the lead handed to the next active player.
  const s = playing([[c(2)], [c(9)], [c(4), c(5)], [c(6), c(7)]], 0);
  playCards(s, 0, ['jade-2']); // seat 0 plays its last card → out
  assert.deepEqual(s.finished, [0]);
  playCards(s, 1, ['jade-9']); // seat 1 beats it with its last card → out, owns the trick
  assert.deepEqual(s.finished, [0, 1]);
  assert.equal(s.turn, 2);

  pass(s, 2);
  pass(s, 3); // everyone after the (now out) winner has passed

  assert.equal(s.trick.top, null, 'the trick closes instead of looping forever');
  assert.deepEqual(
    s.captured[1].map((x) => x.id).sort(),
    ['jade-2', 'jade-9'],
    'the winner (seat 1) collects the trick even though they are out',
  );
  assert.equal(s.turn, 2, 'the lead passes to the next active player');
});

test('an active wish forces a player to play the wished rank when able', () => {
  const s = playing([[c(5), c(2)], [c(8), c(9)], [c(3)], [c(4)]], 0);
  s.wish = 8; // pretend the Mahjong already wished for 8
  playCards(s, 0, ['jade-5']); // seat 0 leads a 5; seat 1 to move, holds a playable 8

  assert.throws(() => pass(s, 1), /소원/); // may not pass — the 8 beats the 5
  assert.throws(() => playCards(s, 1, ['jade-9']), /소원/); // may not play a non-wish card
  playCards(s, 1, ['jade-8']); // must play the 8
  assert.equal(s.wish, null, 'the wish is cleared once fulfilled');
});

test('a wish does not bind a player who cannot legally play the rank', () => {
  // seat 1 holds an 8 but it cannot beat the led King, so the wish does not bind.
  const s = playing([[c(13), c(2)], [c(8), c(9)], [c(3)], [c(4)]], 0);
  s.wish = 8;
  playCards(s, 0, ['jade-13']); // lead a King
  pass(s, 1); // allowed: the 8 (or 9) cannot beat the King
  assert.equal(s.wish, 8, 'the wish stays outstanding');
});

test('a wish does not bind a player who lacks the rank entirely', () => {
  const s = playing([[c(5), c(2)], [c(9), c(10)], [c(3)], [c(4)]], 0);
  s.wish = 8;
  playCards(s, 0, ['jade-5']);
  pass(s, 1); // seat 1 has no 8 at all
});

test('a wish does not bind when only a bomb could fulfil it', () => {
  // seat 1's only Ace-bearing legal play over the led straight is the four-Ace
  // bomb — and you are never forced to play a bomb to fulfil a wish.
  const aces = [c(14, 'jade'), c(14, 'star'), c(14, 'sword'), c(14, 'pagoda')];
  const s = playing(
    [[c(3), c(4), c(5), c(6), c(7), c(2)], [...aces, c(9, 'star')], [c(3, 'star')], [c(4, 'star')]],
    0,
  );
  s.wish = 14; // wished for Aces
  playCards(s, 0, ['jade-3', 'jade-4', 'jade-5', 'jade-6', 'jade-7']); // lead a 5-straight
  assert.doesNotThrow(() => pass(s, 1)); // the bomb does not bind → may pass
  assert.equal(s.wish, 14, 'the wish stays outstanding');
});

test('a player may still voluntarily bomb to fulfil a wish', () => {
  const aces = [c(14, 'jade'), c(14, 'star'), c(14, 'sword'), c(14, 'pagoda')];
  const s = playing([[c(5), c(2)], [...aces], [c(3, 'star')], [c(4, 'star')]], 0);
  s.wish = 14;
  playCards(s, 0, ['jade-5']);
  // Not forced, but the bomb is a legal play and still fulfils (clears) the wish.
  playCards(s, 1, ['jade-14', 'star-14', 'sword-14', 'pagoda-14']);
  assert.equal(s.wish, null, 'voluntarily playing the Ace bomb clears the wish');
});
