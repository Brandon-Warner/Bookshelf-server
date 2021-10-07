const { ApolloServer, gql, UserInputError, AuthenticationError } = require('apollo-server');
const { PubSub } = require('graphql-subscriptions');
const pubsub = new PubSub();
const jwt = require('jsonwebtoken');
require('dotenv').config();
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Author = require('./models/Author');
const Book = require('./models/Book');
const User = require('./models/User');

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
// const PASSWORD = process.env.PASSWORD;

console.log('connecting to ', MONGODB_URI);

mongoose
    .connect(MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        useFindAndModify: false,
        useCreateIndex: true
    })
    .then(() => {
        console.log('connected to MongoDB');
    })
    .catch(error => {
        console.log('error connecting to MongoDB: ', error.message);
    });

// mongoose.set('debug', true);

const typeDefs = gql`
    type Book {
        title: String!
        published: Int!
        author: Author!
        genres: [String!]!
        id: ID!
    }

    input AuthorInput {
        name: String!
        born: Int
    }

    type Author {
        name: String!
        born: Int
        bookCount: Int!
        id: ID!
    }

    type User {
        username: String!
        password: String!
        favoriteGenre: String!
        id: ID!
    }

    type Token {
        value: String!
    }

    type Query {
        bookCount: Int!
        authorCount: Int!

        allBooks(author: String, genre: String): [Book!]!
        allAuthors: [Author!]!
        me: User
    }

    type Mutation {
        addBook(title: String!, author: String!, published: Int!, genres: [String!]): Book
        editAuthor(name: String!, setBornTo: Int!): Author
        createUser(username: String!, password: String!, favoriteGenre: String!): User
        login(username: String!, password: String!): Token
    }

    type Subscription {
        bookAdded: Book!
    }
`;

const resolvers = {
    Query: {
        bookCount: () => Book.collection.countDocuments(),
        authorCount: () => Author.collection.countDocuments(),
        allBooks: async (root, args) => {
            if (args.author) {
                const author = await Author.findOne({ name: args.author });
                if (author) {
                    if (args.genre) {
                        return await Book.find({
                            author: author.id,
                            genres: { $in: [args.genre] }
                        }).populate('author');
                    }
                    return await Book.find({ author: author.id }).populate('author');
                }
                return null;
            }

            if (args.genre) {
                return Book.find({ genres: { $in: [args.genre] } }).populate('author');
            }

            return Book.find({}).populate('author');
        },
        allAuthors: () => Author.find({}),
        me: (root, args, context) => {
            return context.currentUser;
        }
    },
    Author: {
        bookCount: async root => {
            const author = await Author.findOne({ name: root.name });
            const books = await Book.find({ author: author.id });
            return books.length;
        }
    },
    Mutation: {
        addBook: async (root, args, context) => {
            const foundBook = await Book.findOne({ title: args.title });
            const foundAuthor = await Author.findOne({ name: args.author });
            const user = context.currentUser;

            if (!user) {
                throw new AuthenticationError('cannot add book until signed in');
            }

            if (foundBook) {
                throw new UserInputError('Book already exists', {
                    invalidArgs: args
                });
            }

            if (!foundAuthor) {
                const author = new Author({ ...args, name: args.author });
                try {
                    await author.save();
                } catch (error) {
                    throw new UserInputError('error with author input', error.message, {
                        invalidArgs: args
                    });
                }
            }

            const foundAuthor2 = await Author.findOne({ name: args.author });
            const book = new Book({ ...args, author: foundAuthor2 });

            try {
                await book.save();
            } catch (error) {
                throw new UserInputError(error.message, {
                    invalidArgs: args
                });
            }

            pubsub.publish('BOOK_ADDED', { bookAdded: book });

            return book;
        },
        editAuthor: async (root, args, context) => {
            const user = context.currentUser;
            let author = await Author.findOne({ name: args.name });

            if (!user) {
                throw new AuthenticationError('cannot edit authors until signed in', {
                    invalidArgs: args
                });
            }

            if (!author) {
                throw new UserInputError('Author does not exist', {
                    invalidArgs: args
                });
            }
            const filter = { name: args.name };
            const updateDoc = {
                $set: {
                    born: args.setBornTo
                }
            };
            const options = {};

            try {
                await Author.updateOne(filter, updateDoc, options);
            } catch (error) {
                throw new UserInputError(error.message, {
                    invalidArgs: args
                });
            }
            return await Author.findOne({ name: args.name });
        },
        createUser: async (root, { username, password, favoriteGenre }) => {
            // username, password, and favoriteGenre are destructured from the args
            const saltRounds = 12;

            const user = new User();
            user.username = username;
            user.password = await bcrypt.hash(password, saltRounds);
            console.log('user.password: ', user.password);
            user.favoriteGenre = favoriteGenre;

            return user.save().catch(error => {
                throw new UserInputError(error.message, {
                    invalidArgs: args
                });
            });
        },
        login: async (root, args) => {
            console.log('username in login: ', args.username);
            console.log('password in login: ', args.password);
            const user = await User.findOne({ username: args.username });
            console.log('logged in user', user);
            if (!user) {
                throw new UserInputError('No user found');
            }

            // user.password contains the hashed password
            // bcrypt with compare the password from the args to the hashed password from our user
            const isValid = await bcrypt.compare(args.password, user.password);
            console.log('isValid: ', isValid);
            if (!isValid) {
                throw new UserInputError('Incorrect password');
            }

            const userForToken = {
                username: user.username,
                id: user._id
            };

            return { value: jwt.sign(userForToken, JWT_SECRET) };
        }
    },
    Subscription: {
        bookAdded: {
            subscribe: () => pubsub.asyncIterator(['BOOK_ADDED'])
        }
    }
};

const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: async ({ req }) => {
        const auth = req ? req.headers.authorization : null;

        if (auth && auth.toLowerCase().startsWith('bearer ')) {
            const decodedToken = jwt.verify(auth.substring(7), JWT_SECRET);
            const currentUser = await User.findById(decodedToken.id);

            return { currentUser };
        }
    }
});

server.listen().then(({ url, subscriptionsUrl }) => {
    console.log(`Server ready at ${url}`);
    console.log(`Subscriptions ready at ${subscriptionsUrl}`);
});
