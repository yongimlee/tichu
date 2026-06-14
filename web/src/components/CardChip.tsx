import type { CSSProperties } from 'react';
import type { Card } from '@tichu/shared';
import dogImg from '../assets/cards/dog.png';
import dragonImg from '../assets/cards/dragon.png';
import mahjongImg from '../assets/cards/mahjong.png';
import phoenixImg from '../assets/cards/phoenix.png';

const SUIT_GLYPH: Record<string, string> = {
  jade: '✿',
  sword: '⚔',
  pagoda: '⛩',
  star: '★',
};

const RANK_LABEL: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

const SPECIAL: Record<string, { label: string; img: string }> = {
  mahjong: { label: '1', img: mahjongImg },
  dog: { label: '개', img: dogImg },
  phoenix: { label: '봉황', img: phoenixImg },
  dragon: { label: '용', img: dragonImg },
};

/** Plain-text label for a card (used in dropdowns etc.). */
export function cardText(card: Card): string {
  if (card.kind === 'special') return SPECIAL[card.name].label;
  const rank = RANK_LABEL[card.rank] ?? String(card.rank);
  return `${rank}${SUIT_GLYPH[card.suit]}`;
}

interface Props {
  card: Card;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** When set, plays a staggered deal-in animation; the number is the card's
   *  position among the cards being dealt (drives the per-card delay). */
  dealIndex?: number;
}

export function CardChip({ card, selected, disabled, onClick, dealIndex }: Props) {
  const dealing = dealIndex !== undefined;
  const cls = (extra: string) =>
    `card ${extra}${selected ? ' card--selected' : ''}${dealing ? ' card--dealing' : ''}`;
  const style = dealing ? ({ '--deal-i': dealIndex } as CSSProperties) : undefined;

  if (card.kind === 'special') {
    const s = SPECIAL[card.name];
    return (
      <button
        className={cls('card--special')}
        style={style}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        <img className="card__img" src={s.img} alt={s.label} draggable={false} />
      </button>
    );
  }

  const rank = RANK_LABEL[card.rank] ?? String(card.rank);
  return (
    <button
      className={cls(`card--${card.suit}`)}
      style={style}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="card__rank">{rank}</span>
      <span className="card__glyph">{SUIT_GLYPH[card.suit]}</span>
    </button>
  );
}
