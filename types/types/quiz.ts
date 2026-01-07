export interface Question {
  number: number
  question: string
  answer: string
  marks?: number
  max_marks?: number
  remarks?: string
}

export interface StudentQuiz {
  student_name: string
  roll_number?: string
  course?: string
  quiz_number?: string
  questions: Question[]
  total_score?: number
  max_score?: number
}
