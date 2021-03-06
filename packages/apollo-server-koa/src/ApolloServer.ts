import Koa from 'koa';
import corsMiddleware from '@koa/cors';
import bodyParser from 'koa-bodyparser';
import compose from 'koa-compose';
import {
  renderPlaygroundPage,
  RenderPageOptions as PlaygroundRenderPageOptions,
} from '@apollographql/graphql-playground-html';
import { ApolloServerBase, formatApolloErrors } from 'apollo-server-core';
import accepts from 'accepts';
import typeis from 'type-is';

import { graphqlKoa } from './koaApollo';

import { processRequest as processFileUploads } from '@apollographql/apollo-upload-server';

export { GraphQLOptions, GraphQLExtension } from 'apollo-server-core';
import { GraphQLOptions, FileUploadOptions } from 'apollo-server-core';

export interface ServerRegistration {
  app: Koa;
  path?: string;
  playgroundPath?: string;
  cors?: corsMiddleware.Options | boolean;
  bodyParserConfig?: bodyParser.Options | boolean;
  onHealthCheck?: (ctx: Koa.Context) => Promise<any>;
  disableHealthCheck?: boolean;
}

const fileUploadMiddleware = (
  uploadsConfig: FileUploadOptions,
  server: ApolloServerBase,
) => async (ctx: Koa.Context, next: Function) => {
  if (typeis(ctx.req, ['multipart/form-data'])) {
    try {
      ctx.request.body = await processFileUploads(ctx.req, uploadsConfig);
      return next();
    } catch (error) {
      if (error.status && error.expose) ctx.status = error.status;

      throw formatApolloErrors([error], {
        formatter: server.requestOptions.formatError,
        debug: server.requestOptions.debug,
      });
    }
  } else {
    return next();
  }
};

const middlewareFromPath = (
  path: string,
  middleware: compose.Middleware<Koa.Context>,
) => (ctx: Koa.Context, next: () => Promise<any>) => {
  if (ctx.path === path) {
    return middleware(ctx, next);
  } else {
    return next();
  }
};

export class ApolloServer extends ApolloServerBase {
  // This translates the arguments from the middleware into graphQL options It
  // provides typings for the integration specific behavior, ideally this would
  // be propagated with a generic to the super class
  async createGraphQLServerOptions(ctx: Koa.Context): Promise<GraphQLOptions> {
    return super.graphQLServerOptions({ ctx });
  }

  protected supportsSubscriptions(): boolean {
    return true;
  }

  protected supportsUploads(): boolean {
    return true;
  }

  // TODO: While Koa is Promise-aware, this API hasn't been historically, even
  // though other integration's (e.g. Hapi) implementations of this method
  // are `async`.  Therefore, this should become `async` in a major release in
  // order to align the API with other integrations.
  public applyMiddleware({
    app,
    path,
    playgroundPath,
    cors,
    bodyParserConfig,
    disableHealthCheck,
    onHealthCheck,
  }: ServerRegistration) {
    if (!path) path = '/graphql';
    if (!playgroundPath) playgroundPath = path;

    // Despite the fact that this `applyMiddleware` function is `async` in
    // other integrations (e.g. Hapi), currently it is not for Koa (@here).
    // That should change in a future version, but that would be a breaking
    // change right now (see comment above this method's declaration above).
    //
    // That said, we do need to await the `willStart` lifecycle event which
    // can perform work prior to serving a request.  While we could do this
    // via awaiting in a Koa middleware, well kick off `willStart` right away,
    // so hopefully it'll finish before the first request comes in.  We won't
    // call `next` until it's ready, which will effectively yield until that
    // work has finished.  Any errors will be surfaced to Koa through its own
    // native Promise-catching facilities.
    const promiseWillStart = this.willStart();
    app.use(
      middlewareFromPath(path, async (_ctx: Koa.Context, next: Function) => {
        await promiseWillStart;
        return next();
      }),
    );

    if (!disableHealthCheck) {
      app.use(
        middlewareFromPath(
          '/.well-known/apollo/server-health',
          (ctx: Koa.Context) => {
            // Response follows https://tools.ietf.org/html/draft-inadarei-api-health-check-01
            ctx.set('Content-Type', 'application/health+json');

            if (onHealthCheck) {
              return onHealthCheck(ctx)
                .then(() => {
                  ctx.body = { status: 'pass' };
                })
                .catch(() => {
                  ctx.status = 503;
                  ctx.body = { status: 'fail' };
                });
            } else {
              ctx.body = { status: 'pass' };
            }
          },
        ),
      );
    }

    let uploadsMiddleware;
    if (this.uploadsConfig) {
      uploadsMiddleware = fileUploadMiddleware(this.uploadsConfig, this);
    }

    this.graphqlPath = path;
    this.playgroundPath = playgroundPath;

    if (cors === true) {
      app.use(middlewareFromPath(path, corsMiddleware()));
    } else if (cors !== false) {
      app.use(middlewareFromPath(path, corsMiddleware(cors)));
    }

    if (bodyParserConfig === true) {
      app.use(middlewareFromPath(path, bodyParser()));
    } else if (bodyParserConfig !== false) {
      app.use(middlewareFromPath(path, bodyParser(bodyParserConfig)));
    }

    if (uploadsMiddleware) {
      app.use(middlewareFromPath(path, uploadsMiddleware));
    }

    const playgroundRenderPageOptions:
      | PlaygroundRenderPageOptions
      | undefined = this.playgroundOptions
      ? {
          endpoint: path,
          subscriptionEndpoint: this.subscriptionsPath,
          ...this.playgroundOptions,
        }
      : undefined;

    app.use(
      middlewareFromPath(path, (ctx: Koa.Context, next: Function) => {
        if (
          playgroundRenderPageOptions &&
          path === playgroundPath &&
          ctx.request.method === 'GET'
        ) {
          // perform more expensive content-type check only if necessary
          const accept = accepts(ctx.req);
          const types = accept.types() as string[];
          const prefersHTML =
            types.find(
              (x: string) => x === 'text/html' || x === 'application/json',
            ) === 'text/html';

          if (prefersHTML) {
            ctx.set('Content-Type', 'text/html');
            const playground = renderPlaygroundPage(
              playgroundRenderPageOptions,
            );
            ctx.body = playground;
            return;
          }
        }
        return graphqlKoa(() => {
          return this.createGraphQLServerOptions(ctx);
        })(ctx, next);
      }),
    );

    if (playgroundRenderPageOptions && path !== playgroundPath) {
      app.use(
        middlewareFromPath(playgroundPath, (ctx: Koa.Context) => {
          ctx.set('Content-Type', 'text/html');
          const playground = renderPlaygroundPage(playgroundRenderPageOptions);
          ctx.body = playground;
        }),
      );
    }
  }
}

export const registerServer = () => {
  throw new Error(
    'Please use server.applyMiddleware instead of registerServer. This warning will be removed in the next release',
  );
};
