# Example: a finished scope.md

A fictional scope checklist for a customer app. It sets the tone and level of detail to aim for: decisions in a sentence each, a price per phase, and feature lines a customer can test.

---

# Pedal & Co service app: scope checklist

An app where Pedal & Co's customers book a bike service, follow the repair and pay, built on the shop system the workshops already use. This checklist is for deciding together which features to build and in what order. The questions we need answered are at the end.

## Decisions taken

- **iOS and Android first;** a web version later.
- **Pedal & Co owns the customer account.** Customers sign up in the app with their email and connect their existing shop customer number afterwards.
- **Login with email and a one-time code,** plus Sign in with Apple, which Apple requires when other logins are offered.
- **Bookings and repair status come from the shop system,** so the workshops keep working as they do today.
- **Payment through the payment provider Pedal & Co already uses;** the app never stores card details.
- **One app for all six workshops;** the customer picks their usual workshop and can change it.
- **Danish and English** from the start.
- **The admin panel is for head office only** at launch; workshop staff keep using the shop system.
- **Push notifications** when the bike is ready, when a quote needs approval, and for campaigns the customer has agreed to.

## Time

- **About five weeks** from start to finish, ready for the App Store and Google Play.
- **First version ready for testing about two weeks after the start.**

## Price

- **120,000 DKK in total** excl. VAT. The price per phase is in each phase heading below.
- **Payment:** 50% when we start and 50% when the app is live.
- The price assumes access to the shop system's API and a test workshop by the start date, final designs before the build starts, and data shown as the shop system provides it.

## Phase 1: Book and follow a service (55,000 DKK)

- [ ] Sign up and log in with email and a code, or with Apple
- [ ] Connect an existing shop customer number to the account
- [ ] Add one or more bikes with brand, model and frame number
- [ ] Book a service: pick a workshop, a service type and a free time
- [ ] Move or cancel a booking until 24 hours before
- [ ] Follow the repair: received, in progress, waiting for parts, ready
- [ ] Push notification when the bike is ready
- [ ] Service history for each bike
- [ ] Delete the account from the app

## Phase 2: Quotes and payment (30,000 DKK)

- [ ] See a quote for extra work and approve or decline it in the app
- [ ] Push notification when a quote needs approval
- [ ] Pay for the service in the app before pickup
- [ ] Receipts in the service history

## Phase 3: Admin and campaigns (25,000 DKK)

- [ ] Head office sees customers, bikes and bookings without opening the shop system
- [ ] Send a push campaign to all customers or to one workshop's customers
- [ ] Only customers who agreed to marketing receive campaigns
- [ ] Banner on the home screen that head office can change

## Phase 4: Loyalty (10,000 DKK)

Can be moved to any point in the plan.

- [ ] A free basic service after five paid services
- [ ] Progress towards the free service on the home screen

## Pedal & Co tasks outside this project

- [ ] Create the Apple Developer and Google Play accounts in the company's name
- [ ] Get API access and a test workshop from the shop system vendor
- [ ] Write the texts for the App Store, Google Play and the privacy policy
- [ ] Finish the designs for the quote and payment screens

## Later or optional

- [ ] Web version of the app
- [ ] Chat with the workshop about a repair
- [ ] Sell accessories in the app (15,000 DKK)
- [ ] Reminder when the bike is due for its yearly service (5,000 DKK)

## How we work together

- **You are in the loop all the way.** You see the app as it grows, try it on your own phone along the way, and tell us what to change.
- **Plans change once building starts, and that is fine.** Adjustments along the way are usually included. A large new feature gets a price before we start on it, and you decide.

## After launch

- **Operations: 5,000 DKK a month.** We keep the app and the admin running and up to date, and you can write to us with small changes whenever you need them.
- **You own everything:** the code, the store accounts and the hosting. You pay hosting and other services directly to the providers, so you are never locked in to us.
- **Your data stays in the EU,** and we sign a data processing agreement with you.

## What can delay the project

- **Apple and Google:** creating the developer accounts can take a couple of weeks, and every release must pass their review.
- **The shop system:** we need API access and a test workshop from the vendor before we can show real bookings.
- **Payment in the app:** your payment provider must approve payments in an app, which can take a while.
- **Designs:** the quote and payment screens are not designed yet, and phase 2 waits for them.

## Questions for Pedal & Co

Each question has our recommendation, and a "yes" is enough. The first ones block the start.

- [ ] **May we contact the shop system vendor directly about API access?** We recommend yes, as it saves weeks of forwarded emails.
  Answer:
- [ ] **Should the app use the payment provider your webshop already uses?** We recommend yes, so all payments land in the same place.
  Answer:
- [ ] **Should every quote for extra work need the customer's approval in the app?** We recommend approval only above 300 DKK; below that the workshop just does the work.
  Answer:
