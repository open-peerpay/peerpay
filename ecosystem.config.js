module.exports = {
  apps: [
    {
      name: "peerpay",
      script: "./peerpay",
      cwd: "/home/peerpay",
      exec_interpreter: "none",
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: "production",
        PORT: "3000"
      }
    }
  ]
};
