# Example: a finished scope.md

A fictional scope checklist for a customer app. It sets the tone and level of detail to aim for: decisions in a sentence each, a price per phase, and feature lines a customer can test.

---

# Pedal & Co service app: scope checklist

An app where Pedal & Co's customers book a bike service, follow the repair and pay, built on the shop system the workshops already use. This checklist is for deciding together which features to build and in what order. The questions we need answered are in the attached list.

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
- The price assumes access to the shop system's API and a test workshop by the start date, final designs before the build starts, and data shown as the shop system provides it.
- Operations after launch: 6,000 DKK a month for hosting, monitoring, updates and up to four support hours, agreed separately.

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

## Open questions

- [ ] Can the shop system send an update when the repair status changes, or do we have to check it every few minutes?
- [ ] Which payment provider, and does it support payment in an app?
