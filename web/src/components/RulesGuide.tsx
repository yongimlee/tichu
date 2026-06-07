// Collapsible Tichu rules reference, shown from room creation through play.
export function RulesGuide() {
  return (
    <details className="rules">
      <summary>📖 규칙 설명서 (펼치기/접기)</summary>

      <h4>기본 룰</h4>
      <ul>
        <li>4인 2팀 — 마주 보는 사람이 파트너 (자리 0·2 = 팀 A, 1·3 = 팀 B).</li>
        <li>
          분배: <strong>8장</strong> → <strong>6장 추가</strong>(총 14장) → 세 명에게 1장씩{' '}
          <strong>교환</strong>(왼쪽·파트너·오른쪽).
        </li>
        <li>참새(1) 보유자가 첫 리드. 같은 종류의 더 높은 조합으로 받아치거나 패스.</li>
        <li>모두 패스하면 마지막에 낸 사람이 트릭을 가져가고 다음 리드를 합니다.</li>
        <li>
          조합: 싱글 · 페어 · 트리플 · 풀하우스 · 스트레이트(연속 5장↑) · 계단(연속 페어 2쌍↑) ·
          폭탄.
        </li>
        <li>
          점수 카드: <strong>5=5점, 10·K=10점</strong>, 용 +25, 봉황 −25 (한 판 총 100점).
        </li>
        <li>
          한 판 종료(3명 아웃): 꼴찌의 딴 트릭 → 1등에게, 남은 손패 → 상대 팀에게. 양 파트너가
          1·2등이면 <strong>원투 피니시 +200</strong>.
        </li>
        <li>설정한 목표 점수(기본 1000)에 먼저 도달한 팀이 승리.</li>
      </ul>

      <h4>🎯 티츄 선언 (보너스 베팅)</h4>
      <ul>
        <li>
          <strong>라지 티츄 (±200점)</strong> <span className="badge badge--gt">LT</span>: 처음{' '}
          <strong>8장</strong>만 본 상태에서, 카드를 더 받기 전에 선언합니다.
        </li>
        <li>
          <strong>스몰 티츄 (±100점)</strong> <span className="badge">T</span>: 14장을 모두 받은
          뒤부터 <strong>자신이 첫 카드를 내기 전</strong>까지 언제든 선언할 수 있습니다.
        </li>
        <li>
          선언하면 해당 플레이어 좌석에 위 뱃지(<span className="badge badge--gt">LT</span> /{' '}
          <span className="badge">T</span>)가 표시됩니다.
        </li>
        <li>
          성공 조건은 선언한 사람이 그 판에서 <strong>가장 먼저 아웃(1등)</strong>하는 것. 성공하면
          해당 점수를 얻고, 실패하면 같은 점수만큼 잃습니다.
        </li>
        <li>라지 티츄를 선언했다면 스몰 티츄는 따로 선언하지 않습니다(둘 중 하나).</li>
      </ul>

      <h4>💣 폭탄</h4>
      <ul>
        <li>포카드(같은 숫자 4장) 또는 스트레이트 플러시(같은 무늬 연속 5장↑).</li>
        <li>같은 종류가 아니어도 어떤 조합이든 이깁니다. 스트레이트 플러시 &gt; 포카드.</li>
        <li>
          <strong>자기 차례가 아니어도</strong> 진행 중인 트릭에 끼어들어 낼 수 있습니다.
        </li>
      </ul>

      <h4>특수 카드</h4>
      <ul>
        <li>
          🕊️ <strong>참새(1)</strong>: 가장 낮은 단일. 보유자가 첫 리드. 낼 때 2~10, J~A를
          “소원”으로 지정하면, 낼 수 있는 사람은 반드시 그 숫자를 내야 합니다.
        </li>
        <li>
          🐶 <strong>개</strong>: 리드 전용. 점수 없이 리드권을 파트너에게 넘깁니다.
        </li>
        <li>
          🐉 <strong>용</strong>: 가장 높은 단일(+25점). 트릭을 이기면 그 트릭을 상대 팀에게
          넘겨야 합니다.
        </li>
        <li>
          🐦‍🔥 <strong>봉황</strong>: 와일드카드(−25점). 단일로 내면 직전 카드보다 0.5 높음(용은 못
          이김). 폭탄을 제외한 조합의 아무 카드나 대체합니다.
        </li>
      </ul>
    </details>
  );
}
