import type { Vectorizer } from '../../shared/vectorizer'
import { lineDetectorVectorizer } from './line-detector-vectorizer'

const vectorizers: Vectorizer[] = [lineDetectorVectorizer]

export function getVectorizer(id: string): Vectorizer {
  const found = vectorizers.find((vectorizer) => vectorizer.id === id)
  if (!found) throw new Error(`未登録の Vectorizer です: ${id}`)
  return found
}
