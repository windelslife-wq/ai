import mysql from "mysql2/promise";

export function createPool(database) {
  return mysql.createPool({
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    connectionLimit: database.connectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    timezone: "Z",
    charset: "utf8mb4",
    dateStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
}
