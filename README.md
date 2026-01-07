

**AI Grader** is a smart backend system that powers the **AI Grader Virtual Teaching Assistant**.
It automates the process of grading, analyzing, and managing student assessments using AI and OCR technologies.

---

### 🚀 Tech Stack

| Layer                       | Technology                                     |
| --------------------------- | ---------------------------------------------- |
| **Runtime**                 | Node.js (TypeScript)                           |
| **Framework**               | Express.js                                     |
| **AI Integration**          | OpenAI API                                     |
| **OCR / Image Recognition** | Google Cloud Vision API, Tesseract.js          |
| **File Handling**           | Multer, Sharp, pdf-lib, pdf-parse, pdf-poppler |
| **Database / Auth**         | Supabase                                       |
| **Environment Management**  | dotenv                                         |
| **Other Utilities**         | CORS, Node.js core modules                     |

---

### 📦 Project Setup

#### 1️⃣ Clone the Repository

```bash
git clone https://github.com/amnarafi85/AI-Grader-Backend.git
cd AI-Grader-Backend
```

#### 2️⃣ Install Dependencies

```bash
npm install
```

#### 3️⃣ Create Environment Variables

Create a `.env` file in the root folder and add your credentials:

```bash
# Example .env
PORT=5000

# OpenAI
OPENAI_API_KEY=your_openai_api_key

# Google Vision
GOOGLE_APPLICATION_CREDENTIALS=your_google_credentials.json

# Supabase
SUPABASE_URL=https://your-supabase-url.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
```

⚠️ **Note:** The `.env` file is **ignored** via `.gitignore` and should **never be pushed** to GitHub.

---

### 🛠️ Development Commands

| Command         | Description                                         |
| --------------- | --------------------------------------------------- |
| `npm run dev`   | Start development server using ts-node              |
| `npm run build` | Compile TypeScript into JavaScript (`dist/` folder) |
| `npm start`     | Run compiled server from `dist/`                    |

---

### 📁 Project Structure

```
AI-Grader-Backend/
│
├── src/
│   ├── server.ts          # Main Express server file
│   ├── routes/            # API route handlers
│   ├── controllers/       # Logic for grading, file upload, AI calls
│   ├── utils/             # Helper functions
│   ├── services/          # AI, OCR, and Supabase integration services
│   └── middlewares/       # Upload, validation, and error handling
│
├── dist/                  # Compiled JavaScript files (after build)
├── .env                   # Environment variables (not committed)
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

### 🤖 Core Features

✅ AI-based grading using OpenAI
✅ OCR-based answer extraction via Google Vision / Tesseract.js
✅ PDF and image upload support (Multer + Sharp + pdf-lib)
✅ Supabase-based data storage and user management
✅ TypeScript for safer, scalable code
✅ Environment isolation via dotenv
✅ Ready for cloud deployment

---

### 🌐 API Overview (example)

| Method | Endpoint      | Description                           |
| ------ | ------------- | ------------------------------------- |
| `POST` | `/api/upload` | Upload a file (PDF/Image) for grading |
| `POST` | `/api/grade`  | Send extracted text to AI for grading |
| `GET`  | `/api/health` | Health check endpoint                 |

---

### 🧩 Build and Deploy

#### Build for Production:

```bash
npm run build
```

#### Start the Compiled Server:

```bash
npm start
```

---

### 🔒 Environment & Security

* Keep `.env` file **local only**.
* Never expose API keys in the code.
* For deployment, use **environment variables** (e.g., via AWS, Render, or Railway).

---

### 📄 License

This project is licensed under the **MIT License**.
Feel free to use, modify, and distribute — just provide attribution.

---

### 👩‍💻 Author

**Amna Rafi**
📧 [GitHub: amnarafi85](https://github.com/amnarafi85)
💡 *AI Grader – Empowering smart education through automation.*

