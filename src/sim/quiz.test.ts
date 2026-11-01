import { expect, test } from 'vitest';
import { answerQuiz, causeKey, createQuiz, diagnose, nextQuestion, QUIZ_CAUSES, questionSim, quizScore } from './index';

test('1周で原因を1回ずつ出し、同じシードなら同じ問題', () => {
  const z = createQuiz(3);
  expect(z.questions.map(q => causeKey(q.cause)).sort()).toEqual(QUIZ_CAUSES.map(causeKey).sort());
  expect(createQuiz(3)).toEqual(z);
  expect(createQuiz(4)).not.toEqual(z);
});

test('問題の栽培槽は、出題の原因が律速因子になる（見た目の症状が原因と一致する）', () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (const q of createQuiz(seed).questions) {
      const s = questionSim(q), w = diagnose(s).worst;
      expect([w.key, w.side], `${seed} ${q.crop} ${causeKey(q.cause)}`).toEqual([q.cause.factor, q.cause.side]);
      expect(w.value).toBeLessThan(0.4);
      expect(s.crop.growth).toBe(q.growth);
    }
  }
});

test('答えて進め、正解数を数える。答え済みの問題には答えられない', () => {
  const z = createQuiz(1);
  expect(answerQuiz(z, z.questions[0].cause)).toBe(true);
  expect(answerQuiz(z, z.questions[0].cause)).toBeNull();
  expect(nextQuestion(z)).toBe(true);
  const wrong = QUIZ_CAUSES.find(c => causeKey(c) !== causeKey(z.questions[1].cause))!;
  expect(answerQuiz(z, wrong)).toBe(false);
  // 答えていない問題は先へ進めない
  nextQuestion(z);
  expect(nextQuestion(z)).toBe(true);
  expect(z.index).toBe(2);
  for (let i = 2; i < z.questions.length; i++) {
    answerQuiz(z, z.questions[i].cause);
    expect(nextQuestion(z)).toBe(i < z.questions.length - 1);
  }
  expect(quizScore(z)).toBe(z.questions.length - 1);
});
