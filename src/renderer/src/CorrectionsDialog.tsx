import type { CorrectionPlan } from './corrections'

interface Props {
  fileName: string
  plan: CorrectionPlan
  onApply(): void
  onCancel(): void
}

/** 修正ファイルの内容(件数と、適用できない操作)を見せて、一括適用するか確かめる */
export function CorrectionsDialog({ fileName, plan, onApply, onCancel }: Props) {
  const applicable = plan.replacements.size + plan.additions.length + plan.deletions.size
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="修正の取り込み">
      <div className="modal">
        <h2>修正の取り込み</h2>
        <p className="hint">{fileName}</p>
        <table className="counts">
          <tbody>
            <tr>
              <th>置換</th>
              <td>{plan.replacements.size} 件</td>
            </tr>
            <tr>
              <th>追加</th>
              <td>{plan.additions.length} 件</td>
            </tr>
            <tr>
              <th>削除</th>
              <td>{plan.deletions.size} 件</td>
            </tr>
            <tr className={plan.rejected.length > 0 ? 'rejected' : undefined}>
              <th>適用できない</th>
              <td>{plan.rejected.length} 件</td>
            </tr>
          </tbody>
        </table>
        {plan.rejected.length > 0 && (
          <>
            <p>次の操作は飛ばします(番号は operations の中の位置、0 始まり)。</p>
            <ul className="rejected-list">
              {plan.rejected.map((entry) => (
                <li key={entry.index}>
                  <span className="index">#{entry.index}</span> {entry.reason}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="hint">適用すると 1 回の操作として反映され、「元に戻す」1 回で全部戻せます。</p>
        <div className="modal-buttons">
          <button onClick={onCancel}>キャンセル</button>
          <button className="primary" onClick={onApply} disabled={applicable === 0} autoFocus>
            {applicable} 件を適用
          </button>
        </div>
      </div>
    </div>
  )
}
