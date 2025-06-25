import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';

interface DatabaseCluster {
  id: string;
  name: string;
  engine: string;
  version: string;
  connection: {
    uri: string;
    database: string;
    host: string;
    port: number;
    user: string;
    password: string;
    ssl: boolean;
  };
  status: string;
}

class DigitalOceanDatabaseMCP {
  private server: Server;
  private pgPool: Pool | null = null;
  private mysqlPool: mysql.Pool | null = null;
  private dbType: 'postgresql' | 'mysql' | null = null;
  private apiToken: string | null = null;
  private currentCluster: DatabaseCluster | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'digitalocean-database-mcp',
        version: '0.2.0',
        description: 'MCP server for DigitalOcean database interactions with API token support',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'set_api_token',
            description: 'Set your DigitalOcean API token for automatic database discovery',
            inputSchema: {
              type: 'object',
              properties: {
                token: {
                  type: 'string',
                  description: 'Your DigitalOcean API token (get from cloud.digitalocean.com/account/api/tokens)',
                },
              },
              required: ['token'],
            },
          },
          {
            name: 'list_database_clusters',
            description: 'List all your DigitalOcean database clusters',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'connect_by_name',
            description: 'Connect to a database cluster by name using API token',
            inputSchema: {
              type: 'object',
              properties: {
                cluster_name: {
                  type: 'string',
                  description: 'Name of the database cluster to connect to',
                },
                database_name: {
                  type: 'string',
                  description: 'Specific database name (optional, uses default if not provided)',
                },
              },
              required: ['cluster_name'],
            },
          },
          {
            name: 'connect_database',
            description: 'Connect to a DigitalOcean database with manual credentials',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['postgresql', 'mysql'],
                  description: 'Database type',
                },
                host: {
                  type: 'string',
                  description: 'Database host',
                },
                port: {
                  type: 'number',
                  description: 'Database port',
                },
                database: {
                  type: 'string',
                  description: 'Database name',
                },
                username: {
                  type: 'string',
                  description: 'Database username',
                },
                password: {
                  type: 'string',
                  description: 'Database password',
                },
                ssl: {
                  type: 'boolean',
                  description: 'Use SSL connection',
                  default: true,
                },
              },
              required: ['type', 'host', 'database', 'username', 'password'],
            },
          },
          {
            name: 'execute_query',
            description: 'Execute a SQL query on the connected database',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'SQL query to execute',
                },
                params: {
                  type: 'array',
                  description: 'Query parameters for prepared statements',
                  items: {
                    type: 'string',
                  },
                  default: [],
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'list_tables',
            description: 'List all tables in the current database',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'describe_table',
            description: 'Get the schema/structure of a specific table',
            inputSchema: {
              type: 'object',
              properties: {
                table_name: {
                  type: 'string',
                  description: 'Name of the table to describe',
                },
              },
              required: ['table_name'],
            },
          },
          {
            name: 'get_database_info',
            description: 'Get general information about the connected database',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'disconnect_database',
            description: 'Disconnect from the current database',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'set_api_token':
          return this.setApiToken(request.params.arguments);
        case 'list_database_clusters':
          return this.listDatabaseClusters();
        case 'connect_by_name':
          return this.connectByName(request.params.arguments);
        case 'connect_database':
          return this.connectDatabase(request.params.arguments);
        case 'execute_query':
          return this.executeQuery(request.params.arguments);
        case 'list_tables':
          return this.listTables();
        case 'describe_table':
          return this.describeTable(request.params.arguments);
        case 'get_database_info':
          return this.getDatabaseInfo();
        case 'disconnect_database':
          return this.disconnectDatabase();
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async setApiToken(args: any) {
    const { token } = args;
    this.apiToken = token;
    
    // Test the token by making a simple API call
    try {
      const response = await fetch('https://api.digitalocean.com/v2/account', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`API call failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      return {
        content: [
          {
            type: 'text',
            text: `✅ API token set successfully! Connected to account: ${data.account.email}`,
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Invalid API token: ${error.message}`
      );
    }
  }

  private async listDatabaseClusters() {
    if (!this.apiToken) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'API token not set. Please use set_api_token first.'
      );
    }

    try {
      const response = await fetch('https://api.digitalocean.com/v2/databases', {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`API call failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const clusters = data.databases.map((db: any) => ({
        name: db.name,
        engine: db.engine,
        version: db.version,
        status: db.status,
        region: db.region,
        size: db.size,
        num_nodes: db.num_nodes,
        created_at: db.created_at,
      }));

      return {
        content: [
          {
            type: 'text',
            text: `Found ${clusters.length} database clusters:\n\n${JSON.stringify(clusters, null, 2)}`,
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list database clusters: ${error.message}`
      );
    }
  }

  private async connectByName(args: any) {
    if (!this.apiToken) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'API token not set. Please use set_api_token first.'
      );
    }

    try {
      const { cluster_name, database_name } = args;

      // First, get all database clusters
      const response = await fetch('https://api.digitalocean.com/v2/databases', {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`API call failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const cluster = data.databases.find((db: any) => db.name === cluster_name);

      if (!cluster) {
        throw new Error(`Database cluster '${cluster_name}' not found`);
      }

      // Get connection details for the specific cluster
      const connectionResponse = await fetch(`https://api.digitalocean.com/v2/databases/${cluster.id}`, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!connectionResponse.ok) {
        throw new Error(`Failed to get connection details: ${connectionResponse.status}`);
      }

      const connectionData = await connectionResponse.json();
      const db = connectionData.database;

      // Store cluster info
      this.currentCluster = {
        id: db.id,
        name: db.name,
        engine: db.engine,
        version: db.version,
        connection: {
          uri: db.connection.uri,
          database: database_name || db.connection.database,
          host: db.connection.host,
          port: db.connection.port,
          user: db.connection.user,
          password: db.connection.password,
          ssl: db.connection.ssl,
        },
        status: db.status,
      };

      // Now connect using the retrieved credentials
      const connectionArgs = {
        type: db.engine === 'pg' ? 'postgresql' : db.engine,
        host: db.connection.host,
        port: db.connection.port,
        database: database_name || db.connection.database,
        username: db.connection.user,
        password: db.connection.password,
        ssl: db.connection.ssl,
      };

      return await this.connectDatabase(connectionArgs);

    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to connect by name: ${error.message}`
      );
    }
  }

  private async connectDatabase(args: any) {
    try {
      const { type, host, port, database, username, password, ssl } = args;
      
      // Disconnect existing connection if any
      await this.disconnectDatabase();

      this.dbType = type === 'pg' ? 'postgresql' : type;

      if (this.dbType === 'postgresql') {
        this.pgPool = new Pool({
          host,
          port: port || 5432,
          database,
          user: username,
          password,
          ssl: ssl ? { rejectUnauthorized: false } : false,
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });

        // Test connection
        const client = await this.pgPool.connect();
        await client.query('SELECT NOW()');
        client.release();

      } else if (this.dbType === 'mysql') {
        this.mysqlPool = mysql.createPool({
          host,
          port,
          database,
          user: username,
          password,
          ssl: typeof ssl === 'object' ? { rejectUnauthorized: ssl.rejectUnauthorized } : undefined,
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0
        } as mysql.PoolOptions);

        // Test connection
        const connection = await this.mysqlPool.getConnection();
        await connection.execute('SELECT NOW()');
        connection.release();
      }

      const clusterInfo = this.currentCluster ? ` (${this.currentCluster.name})` : '';
      
      return {
        content: [
          {
            type: 'text',
            text: `🚀 Successfully connected to ${this.dbType} database: ${database}${clusterInfo}\n📍 Host: ${host}:${port}\n🔒 SSL: ${ssl ? 'Enabled' : 'Disabled'}`,
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to connect to database: ${error.message}`
      );
    }
  }

  private async executeQuery(args: any) {
    if (!this.pgPool && !this.mysqlPool) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'No database connection. Please connect first using connect_by_name or connect_database.'
      );
    }

    try {
      const { query, params = [] } = args;
      let result: any;

      if (this.dbType === 'postgresql' && this.pgPool) {
        const client = await this.pgPool.connect();
        try {
          result = await client.query(query, params);
        } finally {
          client.release();
        }
      } else if (this.dbType === 'mysql' && this.mysqlPool) {
        const [rows, fields] = await this.mysqlPool.execute(query, params);
        result = { rows, fields };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query,
              rowCount: result.rowCount || result.rows?.length || 0,
              rows: result.rows || result,
              command: result.command,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Query execution failed: ${error.message}`
      );
    }
  }

  private async listTables() {
    if (!this.pgPool && !this.mysqlPool) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'No database connection. Please connect first.'
      );
    }

    try {
      let result: any;

      if (this.dbType === 'postgresql' && this.pgPool) {
        const client = await this.pgPool.connect();
        try {
          result = await client.query(`
            SELECT table_name, table_type
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
          `);
        } finally {
          client.release();
        }
      } else if (this.dbType === 'mysql' && this.mysqlPool) {
        const [rows] = await this.mysqlPool.execute('SHOW TABLES');
        result = { rows };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list tables: ${error.message}`
      );
    }
  }

  private async describeTable(args: any) {
    if (!this.pgPool && !this.mysqlPool) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'No database connection. Please connect first.'
      );
    }

    try {
      const { table_name } = args;
      let result: any;

      if (this.dbType === 'postgresql' && this.pgPool) {
        const client = await this.pgPool.connect();
        try {
          result = await client.query(`
            SELECT 
              column_name,
              data_type,
              is_nullable,
              column_default,
              character_maximum_length
            FROM information_schema.columns
            WHERE table_name = $1 AND table_schema = 'public'
            ORDER BY ordinal_position
          `, [table_name]);
        } finally {
          client.release();
        }
      } else if (this.dbType === 'mysql' && this.mysqlPool) {
        const [rows] = await this.mysqlPool.execute('DESCRIBE ??', [table_name]);
        result = { rows };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              table: table_name,
              columns: result.rows,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to describe table: ${error.message}`
      );
    }
  }

  private async getDatabaseInfo() {
    if (!this.pgPool && !this.mysqlPool) {
      throw new McpError(ErrorCode.InvalidRequest, 'No database connection. Please connect first.');
    }

    try {
      let result: { version: string; database_name: string };

      if (this.dbType === 'postgresql') {
        const client = await this.pgPool!.connect();
        try {
          const versionResult = await client.query<{ version: string }>('SELECT version()');
          const dbResult = await client.query<{ database_name: string }>('SELECT current_database() as database_name');
          result = {
            version: versionResult.rows[0].version,
            database_name: dbResult.rows[0].database_name,
          };
        } finally {
          client.release();
        }
      } else if (this.dbType === 'mysql') {
        const [versionRows] = await this.mysqlPool!.execute<mysql.RowDataPacket[]>('SELECT VERSION() as version');
        const [dbRows] = await this.mysqlPool!.execute<mysql.RowDataPacket[]>('SELECT DATABASE() as database_name');
        result = {
          version: versionRows[0].version as string,
          database_name: dbRows[0].database_name as string,
        };
      } else {
        throw new McpError(ErrorCode.InvalidRequest, 'Invalid database type.');
      }

      return {
        content: [
          {
            type: 'text',
            text: `Database Information:
Type: ${this.dbType}
Version: ${result.version}
Database: ${result.database_name}`,
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get database info: ${error.message}`
      );
    }
  }

  private async disconnectDatabase() {
    try {
      if (this.pgPool) {
        await this.pgPool.end();
        this.pgPool = null;
      }
      if (this.mysqlPool) {
        await this.mysqlPool.end();
        this.mysqlPool = null;
      }
      this.dbType = null;
      this.currentCluster = null;

      return {
        content: [
          {
            type: 'text',
            text: '✅ Database connection closed successfully',
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to disconnect: ${error.message}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('DigitalOcean Database MCP server running on stdio');
  }
}

const server = new DigitalOceanDatabaseMCP();
server.run().catch(console.error);