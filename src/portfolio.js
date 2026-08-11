// --- 🎨 Site Styling ---

const colors = {
    buttonColor: "#4305ba",
    LinkHighlightColor: "#4305ba"
}

// Transitions
const transitions = {
    active: true, // activate for all sections
    onlyLanding: false, // activate only for initial load of landing page
    showOnce: true, // transition only once
    thresholdOption: 0.2 // indicates at what percentage of the sections visibility the transition should start
}

// Splash Screen
const splashScreen = true // recommended: for best behavior after refresh

// --- 👋 Greeting Section ---
const greeting = {
    intro: "Hello 👋, my name is",
    name: "Shubham Yadav",
    message: "Enthusiastic and skilled Frontend Developer seeking to apply and further enhance my development expertise. Eager to collaborate with a dynamic team, contribute to innovative projects, and create user-friendly visually appealing websites and web applications.",
    basedLocation: "India",
    resumeLink: "https://drive.google.com/file/d/1Fa3crXAKGrsCJiQKoEA4TxZt3wjhlhx1/view?usp=sharing", // recommended: google drive file share link (change to "anyone on the internet can view")
    logo: {
        link: "images/initials.png", // use relative path from  parent directory -> ex: images/image.ext
        custom: true // takes precedence over image logo and allows for custom HTML logo (./components/Navbar.vue)
    },
    portraitLink: 'images/recentportrait.png'
}

const socialMediaLinks = {
    github: "https://github.com/ShubhamYadav7106",
    linkedin: "https://www.linkedin.com/in/shubham-yadav-55452028b",
    medium: "",
    stackoverflow: "",
    xtwitter: ""
} // to add any additional social media links check out the README.md or src/icons.js file

// --- 😎 About Section ---
const about = {
    autobiography: [
        "My name is Shubham Yadav, a Computer Science Engineering student and aspiring Full-Stack Developer who enjoys building modern and user-friendly web applications. I have hands-on experience as a Frontend Developer, mainly working with React and TypeScript. During my internships, I worked on real-world projects like InduxCRM, building features such as dashboards, role-based systems, quotations, and invoices.Currently, I’m focused on improving my full-stack skills, especially backend development, APIs, and databases."
    ], // Separated items are paragraphs
    techStack: [
        "JavaScript",
        "TypeScript",
        "React",
        "Node.js",
        "Tailwind",
        "Git",
        "GitHub",
        "Codex"
    ],
    photo1Link: "images/portrait1.jpeg",
    photo2Link: "images/portrait2.jpeg",
    photo3Link: "images/portrait3.jpeg"
}

// --- 🛡️ Experience Section ---

const experiences = [
  {
    position: "Frontend Developer",
    company: {
      name: "Indux Technology",
      link: "https://induxtechnology.com/"
    },
    duration: "Jan 2026 - Present",
    content: [
      {
        sectionHeader: "",
        bulletPoints: [
          "Developed and enhanced a role-based CRM platform using React.js and TypeScript for managing customers, employees, inventory, quotations, invoices, and sales.",
          "Built responsive UI components, dashboards, KPI cards, and customer workflows while improving overall application usability.",
          "Implemented quotation and invoice features including discounts, GST calculations, PDF generation, and resend functionality.",
          "Integrated APIs and contributed to backend workflows using Node.js, Express.js, MongoDB, and GraphQL."
        ]
      }
    ],
    hashtags: [
      "React.js",
      "TypeScript",
      "JavaScript",
      "Node.js",
      "Express.js",
      "MongoDB",
      "GraphQL",
      "Tailwind CSS",
      "Codex",
      "Cursor AI",
      "Claude AI",
      "Git/Github"
    ]
  },

  {
    position: "React.js Developer",
    company: {
      name: "The Entrepreneurship Network",
      link: "https://www.entrepreneurshipnetwork.net/#home"
    },
    duration: "July 2025 - October 2025",
    content: [
      {
        sectionHeader: "",
        bulletPoints: [
          "Developed responsive web applications and reusable UI components using React.js and TypeScript.",
          "Worked on both frontend and basic backend tasks, integrating APIs and implementing application features.",
          "Collaborated with the development team to debug issues, improve existing features, and optimize application performance."
        ]
      }, 
    ],
    hashtags: [
      "React.js",
      "TypeScript",
      "JavaScript",
      "HTML",
      "CSS",
      "Tailwind CSS",
      "Codex",
      "Cursor AI",
      "Claude AI"
    ]
  }
];

// --- 💻 Work Section ---
const works = [
    {
        projectName: "Customer Relationship Management (CRM)",
  yearCompleted: "2026",
  description:
    "Developed a role-based CRM platform with customer, employee, inventory, quotation, invoice, sales, and dashboard modules. Built responsive UI, integrated APIs, and implemented features like GST calculations, discounts, PDF generation, and role-based access.",
  techStack:
    "React.js, TypeScript, Node.js, Express.js, MongoDB, GraphQL, Tailwind CSS",
        // links: [
        //     {
        //         label: "",
        //         type: "git",
        //         url: ""
        //     },
        // ],
        imageLinks: [
          "images/las_dashboard_pic.png",
          "images/crm-rep.png"
        ],
        alignLeft: false
    },
    {
       projectName: "Neuro TEN",
  yearCompleted: "2025",
  description:
    "Contributed to the frontend development of an AI-powered business operations platform. Built responsive landing page sections, interactive UI components, and smooth animations using Framer Motion.",
  techStack:
    "React.js, JavaScript, Tailwind CSS, Framer Motion",
        // links: [
        //     {
        //         label: "",
        //         type: "external",
        //         url: ""
        //     }
        // ],
        imageLink: "images/eduvaultai_dash_pic.png",
        alignLeft: true
    },
    {
   projectName: "React.js & Firebase E-Commerce Platform",
  yearCompleted: "2025",
  description:
    "Developed a responsive e-commerce web application with product listings, search, cart management, and secure user authentication. Built an interactive UI with Tailwind CSS, with AI-assisted workflows for debugging, testing, and feature development.",
  techStack:
    "React.js, Redux, Context API, Firebase, Tailwind CSS",
        links: [
            {
                label: "",
                type: "git",
                url: "https://github.com/ShubhamYadav7106/E-Commerce-web"
            },
            {
                label: "",
                type: "external",
                url: "https://skyecommerceweb.netlify.app/"
            }
        ],
        imageLinks: [
          "images/webdevportfolio_pic.png",
          "images/admin-ecom.png"
        ],
        alignLeft: false
    },
   
]

const archiveLink = "https://github.com/ShubhamYadav7106?tab=repositories"

// --- 📭 Contact Section ---
// 2 Options available - Choose 1
const contact = {
    externalLink: {
        shortTitle: "Get in Touch",
        note: [
            "Reach out if you have any questions or want to collaborate on a project.",
        ], // paragraph breaks will be entered after each item,
        link: {
            email: "shubhamyadav98372@gmail.com", // email takes precedance
            // other: "https://forms"
        },
        responseTimeMessage: ""
    },
    formEmbedLink: "" // inclusion of this link will take precedance
}

export default {
    colors,
    transitions,
    splashScreen,
    greeting,
    socialMediaLinks,
    about,
    experiences,
    works,
    archiveLink,
    contact
}