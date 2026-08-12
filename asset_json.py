import json, re

STYLE = ("black ink hand-drawn whiteboard doodle of {subject}, single centered subject, "
         "simple flat line art, thick uniform strokes, bold clean outlines, minimal detail, "
         "no text, no background, light peach skin, muted flat clothing/object colors"
         "VideoScribe whiteboard animation style, clean closed paths suitable for SVG tracing")

DATA = []

def add(cat, rows):
    for r in rows:
        DATA.append((cat,) + r)

# ---------------- UTILITY: ARROWS & POINTERS ----------------
add("utility/arrows", [
("Arrow Right", "a simple straight arrow pointing right", "Basic straight arrow pointing right. Use for flow, next step, cause leading to effect, or moving forward.", "arrow,right,direction,flow,next,forward"),
("Arrow Left", "a simple straight arrow pointing left", "Straight arrow pointing left. Use for going back, reversing, or referring to a previous point.", "arrow,left,back,reverse,previous"),
("Arrow Up", "a simple straight arrow pointing up", "Straight arrow pointing up. Use for growth, increase, rising prices, improvement or gains.", "arrow,up,increase,growth,rise,gain"),
("Arrow Down", "a simple straight arrow pointing down", "Straight arrow pointing down. Use for decline, loss, falling prices, decrease or drop.", "arrow,down,decrease,decline,fall,loss"),
("Curved Arrow Right", "a hand-drawn curved arrow sweeping to the right", "Curved sweeping arrow. Use to connect two ideas placed apart on the canvas or to show a soft transition.", "arrow,curved,connect,transition,link"),
("Curved Arrow Up", "a hand-drawn curved arrow sweeping upward", "Curved arrow rising upward. Use for gradual growth, recovery, or compounding progress.", "arrow,curved,up,growth,progress,recovery"),
("U-Turn Arrow", "an arrow bending back on itself in a U-turn", "U-turn arrow. Use for reversing a decision, changing course, or undoing a mistake.", "arrow,u-turn,reverse,change,undo,pivot"),
("Circular Loop Arrow", "two arrows forming a closed circular loop", "Circular loop of arrows. Use for cycles, habit loops, repeating patterns, or recurring costs.", "arrow,loop,cycle,repeat,habit,recurring"),
("Dotted Arrow", "an arrow drawn as a dotted or dashed line", "Dashed arrow. Use for an indirect, uncertain, hidden or optional connection between ideas.", "arrow,dotted,dashed,indirect,uncertain,optional"),
("Double Headed Arrow", "a straight line with arrowheads on both ends", "Two-way arrow. Use for trade-offs, comparisons, two-way relationships or tension between options.", "arrow,double,two-way,compare,tradeoff,relationship"),
("Branching Arrow", "one arrow splitting into three arrows pointing different directions", "Arrow splitting into branches. Use for choices, multiple outcomes, diversification or scenarios.", "arrow,branch,split,choice,options,outcomes,diversify"),
("Converging Arrows", "three arrows merging into one single arrow", "Several arrows merging into one. Use for combining income streams, consolidating debt, or focus.", "arrow,merge,converge,combine,focus,consolidate"),
("Zigzag Arrow Up", "a jagged zigzag arrow trending upward", "Zigzag arrow that rises overall. Use for volatile but upward progress, markets, or messy growth.", "arrow,zigzag,volatile,market,progress,up"),
("Arrow Hitting Target", "an arrow striking the center of a bullseye target", "Arrow in a bullseye. Use for goals achieved, precision, hitting a target or success.", "arrow,target,bullseye,goal,success,accuracy"),
("Spiral Arrow Down", "an arrow spiralling downward in a funnel shape", "Downward spiral. Use for debt spirals, anxiety spirals, or escalating decline.", "arrow,spiral,down,debt,anxiety,decline"),
("Hand Pointing Finger", "a hand with index finger pointing to the right", "Pointing hand. Use to draw attention to a word, number or object beside it.", "hand,point,attention,emphasis,look,highlight"),
("Cursor Pointer", "a simple mouse cursor arrow pointer", "Mouse cursor. Use for clicking, online actions, apps or digital behaviour.", "cursor,click,mouse,digital,online,ui"),
])

# ---------------- UTILITY: MARKS & SYMBOLS ----------------
add("utility/marks", [
("Tick Mark", "a bold hand-drawn check mark tick", "Check mark. Use for correct, done, approved, good habit or a completed item.", "tick,check,correct,done,yes,approved,complete"),
("Cross Mark", "a bold hand-drawn X cross mark", "X cross. Use for wrong, rejected, avoid this, failed or a bad habit.", "cross,x,wrong,no,reject,avoid,fail"),
("Tick In Circle", "a check mark inside a hand-drawn circle", "Circled tick. Use as a badge for a verified point, a rule to follow, or a passed test.", "tick,circle,approved,verified,rule,pass"),
("Cross In Circle", "an X mark inside a hand-drawn circle", "Circled X. Use as a prohibition badge, a myth busted, or a rule not to break.", "cross,circle,forbidden,prohibited,myth,busted"),
("Question Mark", "a large bold hand-drawn question mark", "Question mark. Use for doubt, an open question, confusion or the unknown.", "question,doubt,unknown,confusion,ask,why"),
("Exclamation Mark", "a large bold hand-drawn exclamation mark", "Exclamation mark. Use for warning, importance, surprise or a key insight.", "exclamation,warning,important,alert,surprise"),
("Star", "a simple five pointed hand-drawn star", "Star. Use for favourite, quality, rating, reward or an important highlight.", "star,favorite,rating,quality,reward,highlight"),
("Plus Sign", "a bold hand-drawn plus sign", "Plus sign. Use for adding, gains, extra income or a benefit in a pros list.", "plus,add,gain,benefit,pro,more"),
("Minus Sign", "a bold hand-drawn minus sign", "Minus sign. Use for subtracting, expenses, losses or a con in a list.", "minus,subtract,expense,loss,con,less"),
("Equals Sign", "a bold hand-drawn equals sign", "Equals sign. Use for results, equivalence, or the outcome of an equation.", "equals,result,equivalent,outcome,sum"),
("Percent Sign", "a bold hand-drawn percent sign", "Percent symbol. Use for interest rates, returns, inflation or savings rate.", "percent,rate,interest,return,inflation,yield"),
("Infinity Symbol", "a hand-drawn infinity symbol", "Infinity symbol. Use for endless loops, unlimited wants, or forever compounding.", "infinity,endless,unlimited,forever,loop"),
("Circle Highlight", "a rough hand-drawn circle outline used to circle something", "Empty scribbled circle. Use as an overlay to circle and emphasise a word or number.", "circle,highlight,emphasis,annotation,overlay"),
("Underline Scribble", "a rough hand-drawn double underline stroke", "Underline stroke. Use beneath text to emphasise a key phrase.", "underline,emphasis,annotation,highlight,stroke"),
("Strikethrough Line", "a single rough diagonal strike line", "Strike line. Use to cross out a myth, cancel an item, or delete an expense.", "strikethrough,cancel,delete,cross out,remove"),
("Wavy Divider Line", "a long horizontal wavy hand-drawn divider line", "Wavy divider. Use to separate two sections of the canvas or two ideas.", "divider,line,separator,section,wave"),
("Dotted Divider Line", "a long horizontal dotted hand-drawn line", "Dotted divider. Use as a soft separator or a cut-here line.", "divider,dotted,separator,line,cut"),
("Curly Brace", "a large hand-drawn curly brace bracket", "Curly brace. Use to group several items under a single label or total.", "brace,bracket,group,summary,total"),
("Square Brackets", "a pair of hand-drawn square brackets", "Square brackets. Use to isolate a phrase, a time period or a defined term.", "brackets,group,define,isolate,period"),
("Sparkle Burst", "a small burst of three hand-drawn sparkle lines", "Sparkle accent. Use for a new idea, something clean, magical or delightful.", "sparkle,shine,new,idea,magic,accent"),
("Radiating Lines", "short straight lines radiating outward from a center point", "Radiating impact lines. Use around an object to make it pop or show sudden realisation.", "impact,radiate,emphasis,pop,burst,attention"),
("Motion Lines", "three short parallel speed lines", "Speed lines. Use next to a moving object to show speed or urgency.", "motion,speed,fast,movement,urgency"),
])

# ---------------- UTILITY: CONTAINERS, BANNERS, BUBBLES ----------------
add("utility/containers", [
("Rectangle Box", "a plain hand-drawn rectangle outline box", "Simple box frame. Use to contain a word, number or small icon.", "box,rectangle,frame,container,label"),
("Rounded Box", "a hand-drawn rounded corner rectangle outline", "Rounded box. Use as a softer container for a key term or a step in a process.", "box,rounded,frame,container,step"),
("Dashed Box", "a rectangle outline drawn with dashed lines", "Dashed box. Use for a placeholder, an optional item, or something not yet real.", "box,dashed,placeholder,optional,draft"),
("Sticky Note", "a square sticky note with a folded corner", "Sticky note. Use for reminders, quick tips or to-do items.", "note,sticky,reminder,tip,todo"),
("Torn Paper Strip", "a horizontal strip of paper with torn ragged edges", "Torn paper strip. Use as a caption strip, a quote holder or a headline banner.", "paper,torn,strip,caption,quote,banner"),
("Ribbon Banner", "a classic ribbon banner with folded tails", "Ribbon banner. Use for titles, chapter headings or an award label.", "banner,ribbon,title,heading,award"),
("Flag Banner", "a triangular pennant flag on a short pole", "Pennant flag. Use for milestones, a goal reached, or marking a stage.", "flag,pennant,milestone,goal,marker"),
("Scroll Parchment", "an unrolled scroll of parchment with curled ends", "Scroll. Use for rules, an old principle, a law, or ancient wisdom.", "scroll,parchment,rules,law,wisdom,old"),
("Price Tag", "a simple price tag with a string and a hole", "Price tag. Use for cost, price, value or a discount deal.", "tag,price,cost,value,discount,label"),
("Speech Bubble", "an oval speech bubble with a pointed tail", "Speech bubble. Use for what someone says, advice, or a quote.", "speech,bubble,talk,say,quote,dialogue"),
("Thought Bubble", "a cloud shaped thought bubble with small trailing circles", "Thought bubble. Use for what someone is thinking, wanting or imagining.", "thought,bubble,think,imagine,want,mind"),
("Shout Bubble", "a jagged spiky burst shaped speech bubble", "Jagged shout bubble. Use for shouting, urgency, hype, ads or panic.", "shout,burst,loud,urgent,hype,panic"),
("Two Speech Bubbles", "two overlapping speech bubbles facing each other", "Two speech bubbles. Use for conversation, debate, negotiation or disagreement.", "conversation,debate,talk,negotiate,dialogue"),
("Empty Thought Cloud", "a large empty cloud outline", "Plain cloud. Use for daydreams, vague plans, the cloud, or fuzzy thinking.", "cloud,dream,vague,idea,sky"),
("Spotlight Cone", "a cone of light shining down from above", "Spotlight beam. Use to focus attention on one item or person on stage.", "spotlight,focus,attention,stage,highlight"),
("Frame Corner Brackets", "four corner brackets forming a camera style frame", "Corner framing brackets. Use to focus on a detail like a viewfinder.", "frame,focus,zoom,viewfinder,crop"),
])

# ---------------- UTILITY: CHARTS & DIAGRAMS ----------------
add("utility/charts", [
("Bar Chart Rising", "a simple bar chart with four bars increasing in height", "Rising bar chart. Use for growth in income, savings, revenue or progress over time.", "chart,bar,growth,increase,data,progress"),
("Bar Chart Falling", "a simple bar chart with four bars decreasing in height", "Falling bar chart. Use for shrinking savings, declining income or losses.", "chart,bar,decline,decrease,loss,data"),
("Line Graph Up", "a line graph with an upward trending line and axes", "Upward line graph. Use for long-term returns, compounding, or improving metrics.", "graph,line,up,trend,growth,returns"),
("Line Graph Down", "a line graph with a downward trending line and axes", "Downward line graph. Use for a crash, drawdown, or declining performance.", "graph,line,down,crash,decline,drawdown"),
("Volatile Market Chart", "a jagged stock chart line with sharp peaks and dips trending up", "Jagged market chart. Use for volatility, market noise, and long-term upward trend.", "chart,volatility,market,stocks,noise,trend"),
("Candlestick Chart", "three candlestick chart bars with wicks", "Candlestick chart. Use for trading, stock prices and market analysis.", "candlestick,trading,stocks,market,price"),
("Pie Chart", "a circle divided into three pie chart slices", "Pie chart. Use for budget split, asset allocation or portfolio breakdown.", "pie,chart,allocation,budget,split,portfolio"),
("Pie Chart Slice", "a single pie slice separated from a pie chart", "Single pie slice. Use for a share, a portion of income, or one category of spending.", "pie,slice,share,portion,percentage"),
("Flow Chart Three Nodes", "three boxes connected in a row by arrows", "Simple flow chart. Use for a three-step process or a chain of cause and effect.", "flowchart,process,steps,sequence,chain"),
("Venn Diagram", "two overlapping circles forming a venn diagram", "Two-circle Venn diagram. Use for overlap between two ideas or the sweet spot.", "venn,overlap,intersection,compare,sweet spot"),
("Pyramid Hierarchy", "a triangle divided into three horizontal layers", "Layered pyramid. Use for hierarchy of needs, priorities or a wealth pyramid.", "pyramid,hierarchy,layers,priority,needs"),
("Iceberg", "an iceberg with a small tip above the waterline and a large mass below", "Iceberg. Use for hidden costs, unconscious mind, or what lies beneath the surface.", "iceberg,hidden,unconscious,surface,depth"),
("Funnel", "a wide funnel narrowing to a spout", "Funnel. Use for filtering options, narrowing choices, or a sales funnel.", "funnel,filter,narrow,process,sales"),
("Balance Scale", "an old fashioned two pan balance scale", "Balance scale. Use for trade-offs, risk vs reward, pros and cons, or fairness.", "scale,balance,tradeoff,compare,fairness,justice"),
("Seesaw Tilted", "a seesaw plank tilted heavily to one side on a triangle fulcrum", "Tilted seesaw. Use for imbalance, one side outweighing the other, or bias.", "seesaw,imbalance,tilt,weight,bias"),
("Timeline With Milestones", "a horizontal line with four milestone dots and small vertical ticks", "Timeline. Use for phases over years, a plan schedule, or life stages.", "timeline,schedule,phases,years,plan,milestones"),
("Checklist", "a clipboard list with three lines and tick boxes", "Checklist. Use for steps to follow, a to-do list or requirements.", "checklist,list,todo,steps,clipboard,tasks"),
("Matrix Four Quadrants", "a square divided into four quadrants by a cross", "Two-by-two matrix. Use for frameworks like urgent vs important or risk vs return.", "matrix,quadrant,framework,compare,grid"),
("Progress Bar", "a horizontal rounded progress bar filled about seventy percent", "Progress bar. Use for goal progress, savings target completion or loading.", "progress,bar,goal,completion,target,percent"),
("Growth Curve Hockey Stick", "a curve that stays flat then bends sharply upward", "Hockey-stick curve. Use for compounding, exponential growth or a late breakthrough.", "curve,exponential,compounding,hockey stick,growth"),
])

# ---------------- FINANCE: MONEY OBJECTS ----------------
add("finance/money", [
("Single Coin", "a single round coin with a currency symbol face", "One coin. Use for a small amount, a unit of money, or every rupee/dollar counts.", "coin,money,cash,unit,penny,small amount"),
("Coin Stack Small", "a short stack of three coins", "Small coin stack. Use for modest savings, starting small, or a little money.", "coins,stack,savings,small,start"),
("Coin Stack Growing", "three stacks of coins increasing in height side by side", "Growing coin stacks. Use for compounding, steady saving, or increasing wealth.", "coins,stacks,growth,compounding,savings,wealth"),
("Coin Pile", "a loose pile of many scattered coins", "Pile of coins. Use for accumulated change, spare cash or a savings heap.", "coins,pile,heap,change,cash,accumulate"),
("Cash Note", "a single rectangular banknote with a circle in the middle", "Single banknote. Use for cash, a payment, a bill or spending money.", "cash,note,bill,banknote,money,payment"),
("Cash Bundle", "a banded bundle of banknotes", "Bundle of notes. Use for a lump sum, a bonus, salary or a big payment.", "cash,bundle,stack,lump sum,bonus,salary"),
("Cash Pile", "a large messy pile of banknotes and coins", "Big money pile. Use for wealth, a fortune, or a large accumulated sum.", "cash,pile,wealth,fortune,rich,money"),
("Money Bag", "a cloth money bag with a tied neck and a currency symbol", "Money bag. Use for a fund, a stash, a prize or a big sum of cash.", "money bag,sack,fund,stash,prize,cash"),
("Fan Of Notes", "a hand-held fan of banknotes spread out", "Fanned banknotes. Use for showing off money, spending power or flaunting wealth.", "cash,fan,notes,flaunt,rich,spending"),
("Gold Bar", "a single stacked gold bullion bar", "Gold bar. Use for gold, hard assets, store of value or reserves.", "gold,bullion,bar,asset,store of value,reserve"),
("Gold Bar Stack", "three gold bullion bars stacked in a pyramid", "Stack of gold bars. Use for reserves, hedging, or precious metal investing.", "gold,bars,stack,reserves,hedge,precious metal"),
("Diamond Gem", "a cut diamond gem with facet lines", "Diamond. Use for luxury, a valuable asset, or something rare and precious.", "diamond,gem,luxury,valuable,rare,precious"),
("Treasure Chest", "an open treasure chest overflowing with coins", "Treasure chest. Use for a windfall, hidden wealth, or a big reward.", "treasure,chest,windfall,reward,wealth,hidden"),
("Money With Wings", "a banknote with small wings flying away", "Flying money. Use for money leaving fast, wasteful spending or lost cash.", "money,wings,flying away,waste,spending,loss"),
("Burning Money", "a banknote with flames on one corner", "Burning cash. Use for wasting money, high fees, or destroying value.", "money,burning,waste,fees,loss,destroy"),
("Money Down Drain", "coins falling into an open drain", "Money down the drain. Use for leaking expenses, wasted subscriptions or bad spending.", "drain,waste,leak,expense,loss,subscription"),
("Leaky Bucket Of Coins", "a bucket full of coins with coins leaking from holes in the side", "Leaky bucket of money. Use for hidden costs, lifestyle creep or savings leaks.", "bucket,leak,holes,expense,lifestyle creep,savings"),
("Money Tree", "a small tree with coins hanging from its branches", "Money tree. Use for passive income, investing, or the myth that money grows on trees.", "money tree,passive income,growth,invest,myth"),
("Coin Faucet", "a tap faucet with coins dripping out of it", "Coin faucet. Use for a steady income stream, cash flow or dividends.", "faucet,tap,income,cash flow,stream,dividends"),
("Snowball Of Coins", "a snowball rolling downhill made of coins and getting larger", "Money snowball. Use for compounding, the debt snowball method or momentum.", "snowball,compounding,momentum,debt,growth"),
("Empty Wallet", "an open wallet turned upside down with nothing falling out", "Empty wallet. Use for broke, out of money, or end-of-month emptiness.", "wallet,empty,broke,no money,poor"),
("Full Wallet", "a wallet with banknotes sticking out of the top", "Full wallet. Use for having cash, disposable income or being paid.", "wallet,full,cash,income,paid,money"),
("Purse", "a small clasp purse", "Purse. Use for personal spending money, household budget or petty cash.", "purse,wallet,spending,budget,cash"),
("Empty Pockets", "a pair of trouser pockets turned inside out", "Turned-out pockets. Use for broke, no savings, or being cleaned out.", "pockets,empty,broke,poor,no money"),
])

add("finance/saving", [
("Piggy Bank", "a classic piggy bank with a coin slot", "Piggy bank. Use for saving, a savings habit, or setting money aside.", "piggy bank,save,savings,habit,deposit"),
("Piggy Bank With Coin", "a hand dropping a coin into a piggy bank slot", "Saving a coin into a piggy bank. Use for the act of saving each month.", "piggy bank,coin,deposit,save,monthly,habit"),
("Piggy Bank Breaking", "a piggy bank cracked open with coins spilling out", "Broken piggy bank. Use for dipping into savings, an emergency, or breaking a goal.", "piggy bank,broken,emergency,withdraw,spend savings"),
("Savings Jar", "a glass jar half filled with coins and a paper label", "Labelled savings jar. Use for a sinking fund, a goal jar, or envelope-style saving.", "jar,savings,goal,sinking fund,label"),
("Three Budget Jars", "three labelled glass jars in a row with different coin levels", "Three budget jars. Use for splitting income between needs, wants and savings.", "jars,budget,split,allocation,needs,wants,savings"),
("Cash Envelope", "an envelope with banknotes sticking out and a label line", "Cash envelope. Use for envelope budgeting, an allowance, or a monthly cash limit.", "envelope,budget,cash,allowance,limit"),
("Safe Vault", "a heavy safe with a round combination dial", "Safe. Use for secure savings, protecting assets or a locked emergency fund.", "safe,vault,secure,protect,savings,lock"),
("Bank Vault Door", "a large round bank vault door with a wheel handle", "Bank vault door. Use for banks, security, reserves or something locked away.", "vault,bank,security,reserves,locked"),
("Emergency Fund Kit", "a first aid style box labelled with a cross containing coins", "Emergency fund box. Use for a rainy-day fund, financial safety net or buffer.", "emergency fund,safety net,buffer,rainy day,reserve"),
("Umbrella Over Coins", "an open umbrella sheltering a stack of coins from rain", "Umbrella protecting money. Use for insurance, protection, or a rainy-day fund.", "umbrella,insurance,protection,rainy day,shelter"),
("Nest Egg", "a bird nest holding a single large egg", "Nest egg. Use for retirement savings, a long-term fund or protecting capital.", "nest egg,retirement,savings,long term,capital"),
("Coin Jar Overflowing", "a jar so full of coins that they spill over the rim", "Overflowing coin jar. Use for surplus, exceeding a savings goal or abundance.", "jar,overflow,surplus,abundance,goal reached"),
])

add("finance/banking", [
("Bank Building", "a classical bank building with columns and steps", "Bank building. Use for banks, institutions, deposits or the financial system.", "bank,building,institution,deposit,finance"),
("ATM Machine", "an ATM cash machine with a screen and keypad", "ATM. Use for withdrawing cash, easy access to money or an impulse withdrawal.", "atm,cash machine,withdraw,bank,cash"),
("Credit Card", "a rectangular credit card with a chip and stripe", "Credit card. Use for credit, borrowing, card spending or convenience.", "credit card,card,credit,borrow,spend,debt"),
("Credit Card Cut In Half", "a credit card cut into two pieces with scissors nearby", "Cut-up credit card. Use for quitting credit, closing an account or ending debt.", "credit card,cut,quit,close,stop debt,scissors"),
("Debit Card Swipe", "a hand swiping a card through a card reader terminal", "Card payment. Use for checkout, tapping to pay or frictionless spending.", "card,swipe,payment,checkout,terminal,pos"),
("Cheque", "a rectangular bank cheque with signature and amount lines", "Cheque. Use for a payment, a payout, or an old-fashioned transfer.", "cheque,check,payment,payout,bank"),
("Bank Passbook", "a small bank passbook with printed line entries", "Passbook. Use for account records, balance history or traditional banking.", "passbook,account,balance,records,bank"),
("Mobile Banking Phone", "a smartphone showing a bank balance and a coin icon on screen", "Banking app on a phone. Use for digital payments, checking balance or fintech.", "phone,app,mobile banking,fintech,balance,digital"),
("Digital Wallet Payment", "a phone tapping a payment terminal with small signal waves", "Tap to pay. Use for UPI/contactless payment, easy spending or digital money.", "upi,contactless,tap,payment,digital wallet,phone"),
("QR Code Payment", "a square QR code with a phone camera framing it", "QR payment. Use for scan-to-pay, small merchants or instant transfers.", "qr,scan,payment,transfer,merchant"),
("Bank Statement", "a sheet of paper with rows of numbers and a total line", "Bank statement. Use for reviewing transactions, tracking spending or an audit.", "statement,transactions,review,tracking,audit,paper"),
("Wire Transfer", "two bank buildings connected by an arrow with a coin on it", "Money transfer between banks. Use for remittance, transfers or moving funds.", "transfer,wire,remittance,move money,banks"),
("Interest Rate Percent", "a percent sign resting on top of a stack of coins", "Interest rate. Use for savings rates, loan rates, returns or the cost of money.", "interest,rate,percent,loan,savings,yield"),
("Compound Interest Spiral", "coins arranged in an outward growing spiral getting bigger", "Compounding spiral. Use for compound interest, time in the market or snowballing returns.", "compound,interest,spiral,growth,time,returns"),
])

add("finance/debt", [
("Debt Boulder", "a person pushing a large boulder labelled with a currency symbol uphill", "Pushing a debt boulder uphill. Use for the burden of debt or a heavy financial load.", "debt,boulder,burden,struggle,uphill,load"),
("Ball And Chain Money", "an ankle shackle attached by chain to a heavy ball with a currency symbol", "Debt ball and chain. Use for being trapped by loans, EMIs or obligations.", "debt,chain,trapped,loan,emi,obligation"),
("Broken Chain", "a chain link snapping apart in the middle", "Breaking chains. Use for becoming debt free, breaking a habit or gaining freedom.", "chain,break,freedom,debt free,liberation"),
("Loan Document", "a document page with a large signature line and a pen", "Loan agreement. Use for borrowing, signing terms, contracts or fine print.", "loan,document,contract,sign,agreement,terms"),
("Fine Print Magnifier", "a magnifying glass over tiny lines of text on a contract", "Reading the fine print. Use for hidden terms, fees or scrutinising a deal.", "fine print,magnifier,terms,hidden,fees,contract"),
("Bill Stack", "a stack of paper bills with an envelope on top", "Pile of bills. Use for monthly obligations, mounting expenses or dues.", "bills,stack,expenses,dues,monthly,envelope"),
("Overdue Bill", "a bill page with a bold stamp mark across it", "Overdue bill. Use for late payments, penalties or missed deadlines.", "overdue,late,bill,penalty,missed,due"),
("EMI Calendar", "a calendar page with a coin marked on one repeating date", "Recurring payment date. Use for EMIs, rent day, or a monthly commitment.", "emi,calendar,recurring,monthly,payment,rent"),
("Credit Score Gauge", "a semicircular gauge dial with a needle pointing to the high end", "Credit score gauge. Use for creditworthiness, ratings or a risk meter.", "credit score,gauge,rating,meter,risk"),
("Debt Snowball Stairs", "small to large coin stacks arranged like steps with an arrow going up", "Ordered debt payoff. Use for the snowball or avalanche debt payoff method.", "debt payoff,snowball,avalanche,steps,order,method"),
("Sinking Ship With Coins", "a small boat sinking with coins spilling into the water", "Sinking with money. Use for insolvency, bankruptcy or a failing venture.", "sinking,bankrupt,insolvent,failure,loss,ship"),
("Hole In Ground With Money", "coins falling into a deep hole in the ground", "Money into a hole. Use for a money pit, bad investment or endless costs.", "hole,money pit,bad investment,loss,endless cost"),
])

add("finance/invest", [
("Stock Exchange Building", "a stock exchange building with a large ticker board on the front", "Stock exchange. Use for markets, trading floors or public companies.", "stock exchange,market,trading,shares,building"),
("Bull", "a charging bull with head lowered", "Bull. Use for a bull market, optimism or rising prices.", "bull,bull market,rising,optimism,up"),
("Bear", "a standing bear with raised paws", "Bear. Use for a bear market, pessimism or falling prices.", "bear,bear market,falling,pessimism,down"),
("Stock Certificate", "an ornate share certificate document with a seal", "Share certificate. Use for owning equity, shares or a stake in a company.", "share,stock,certificate,equity,ownership,stake"),
("Index Fund Basket", "a woven basket holding several small labelled blocks", "Basket of holdings. Use for index funds, diversification or a fund of many stocks.", "index fund,basket,diversification,fund,holdings,etf"),
("Diversified Eggs In Baskets", "three baskets each holding two eggs", "Eggs in several baskets. Use for diversification and not risking everything in one place.", "diversification,eggs,baskets,risk,spread"),
("All Eggs One Basket", "a single basket holding many eggs stacked precariously", "All eggs in one basket. Use for concentration risk or an all-in bet.", "concentration,risk,all in,eggs,basket,bet"),
("Real Estate House", "a simple house with a chimney and a small yard", "House. Use for real estate, home ownership, rent or property investing.", "house,home,real estate,property,rent,ownership"),
("House With Sold Sign", "a house with a small yard sign board in front", "House with sign board. Use for buying, selling or listing a property.", "house,sold,sign,buy,sell,property,listing"),
("House Key", "a single key with a small house shaped keyring", "House key. Use for possession, home ownership or unlocking a new home.", "key,house,ownership,home,unlock"),
("Apartment Building", "a multi storey apartment building with rows of windows", "Apartment block. Use for rental income, urban property or REITs.", "apartment,building,rental,property,reit,urban"),
("Land Plot", "a rectangular plot of land with corner boundary posts", "Plot of land. Use for land investment, an asset or a physical holding.", "land,plot,property,asset,boundary"),
("Bond Certificate", "a formal bond certificate document with a ribbon seal", "Bond. Use for fixed income, lending to a company or a safer asset.", "bond,fixed income,debt security,safe,lending"),
("Fixed Deposit Receipt", "a small receipt slip with a lock icon and an amount line", "Fixed deposit. Use for locked-in savings, guaranteed returns or low risk.", "fixed deposit,fd,locked,guaranteed,low risk,savings"),
("Crypto Coin", "a round coin with a blockchain cube symbol on its face", "Crypto coin. Use for cryptocurrency, speculation or digital assets.", "crypto,bitcoin,digital asset,speculation,coin"),
("Blockchain Blocks", "four connected cubes in a chain linked by short lines", "Chain of blocks. Use for blockchain, a distributed ledger or web3 topics.", "blockchain,ledger,chain,web3,tech"),
("Dividend Payout", "a company building with coins dropping from it into an open hand", "Dividend payout. Use for dividends, shareholder returns or income from assets.", "dividend,payout,income,shareholder,returns"),
("Portfolio Folder", "a folder with a small pie chart on the cover", "Portfolio folder. Use for holdings, an investment mix or allocation review.", "portfolio,folder,holdings,allocation,mix,review"),
("Risk Meter Dial", "a dial gauge with a needle pointing to the high risk zone", "Risk dial. Use for risk level, volatility tolerance or danger of an investment.", "risk,meter,dial,volatility,tolerance,danger"),
("Roller Coaster Market", "a roller coaster track with steep drops and a small cart", "Market roller coaster. Use for volatility, emotional investing or wild swings.", "roller coaster,volatility,emotions,market,swings"),
("Long Term Tree Growth", "three stages of a tree from seedling to full tree in a row", "Seed to tree growth stages. Use for long-term investing, patience and compounding.", "tree,growth,stages,long term,patience,compounding"),
("Rocket Launch", "a small rocket taking off with a trail of smoke", "Rocket launch. Use for a surge, hype, a moonshot or rapid growth.", "rocket,launch,surge,hype,growth,moonshot"),
("Bubble About To Pop", "a large soap bubble with a needle approaching it", "Bubble and needle. Use for an asset bubble, hype about to burst or overvaluation.", "bubble,pop,burst,hype,overvalued,crash"),
])

add("finance/income", [
("Paycheck Slip", "a payslip document with rows and a highlighted total line", "Payslip. Use for salary, take-home pay, deductions or a monthly income.", "payslip,salary,paycheck,income,deductions,monthly"),
("Salary Handshake", "a hand passing an envelope of cash to another hand", "Handing over pay. Use for getting paid, a raise, a fee or a deal payment.", "salary,payment,handover,paid,fee,cash"),
("Multiple Income Streams", "three pipes each pouring coins into one single bucket", "Several income streams into one bucket. Use for multiple income sources or side hustles.", "income streams,multiple,side hustle,pipes,diversify"),
("Passive Income Tap", "a tap fixed into a wall with coins flowing out into a bucket", "Passive income tap. Use for income while you sleep, royalties or rent.", "passive income,tap,royalty,rent,automatic"),
("Active Income Treadmill", "a person running on a treadmill with a coin appearing at each step", "Running on a treadmill for coins. Use for trading time for money or the rat race.", "active income,treadmill,time for money,rat race,grind"),
("Side Hustle Laptop", "a laptop with a coin coming out of the screen and a mug beside it", "Laptop side hustle. Use for freelancing, online income or a second job.", "side hustle,freelance,laptop,online income,second job"),
("Freelance Invoice", "an invoice sheet with line items and a total box", "Invoice. Use for billing a client, freelance work or getting paid for a project.", "invoice,billing,freelance,client,project,payment"),
("Business Shop Front", "a small shop front with an awning and a door", "Small shop. Use for a small business, a local store or entrepreneurship.", "shop,business,store,entrepreneur,local"),
("Startup Idea Rocket Note", "a notebook page with a lightbulb and a small rocket sketch", "Startup idea page. Use for launching a venture, a business idea or a new plan.", "startup,idea,venture,launch,business,plan"),
("Royalty Book Coins", "a closed book with coins stacked on top of it", "Book earning royalties. Use for royalties, intellectual property or evergreen income.", "royalty,book,ip,passive,evergreen,income"),
("Rent Collection", "a hand receiving a banknote in front of a small house", "Collecting rent. Use for rental income, landlords or property cash flow.", "rent,landlord,rental income,property,cash flow"),
("Pension Chair", "an empty rocking chair with a small coin stack beside it", "Rocking chair with savings. Use for retirement, pension or life after work.", "pension,retirement,chair,old age,after work"),
("Retirement Beach", "a beach umbrella with a lounge chair and a small palm tree", "Retirement beach scene. Use for financial freedom, retiring early or leisure.", "retirement,beach,freedom,fire,leisure,relax"),
])

add("finance/spending", [
("Shopping Cart", "a shopping trolley cart with a few items inside", "Shopping cart. Use for buying, groceries, retail or an online basket.", "cart,shopping,buy,retail,groceries,basket"),
("Shopping Bags", "two shopping bags with handles", "Shopping bags. Use for consumer spending, retail therapy or splurging.", "shopping bags,spending,retail,splurge,consumer"),
("Sale Discount Sign", "a starburst sign shape with a percent symbol in the middle", "Discount starburst. Use for sales, deals, marketing pressure or a bargain.", "sale,discount,deal,offer,bargain,marketing"),
("Impulse Buy Cart Overflowing", "a shopping cart overflowing with items spilling out", "Overflowing cart. Use for impulse buying, overspending or consumerism.", "impulse,overspend,consumerism,cart,excess"),
("Receipt Long", "a very long paper receipt curling at the bottom", "Long receipt. Use for a big bill, itemised spending or hidden costs.", "receipt,bill,long,itemised,spending,cost"),
("Restaurant Bill", "a small folded bill holder with a receipt and a coin on it", "Restaurant bill. Use for eating out, small daily expenses or the latte factor.", "restaurant,bill,eating out,daily expense,latte factor"),
("Coffee Cup", "a takeaway coffee cup with a lid and sleeve", "Takeaway coffee. Use for small recurring expenses or the daily coffee habit.", "coffee,cup,daily expense,habit,small spend,latte"),
("Subscription Recurring", "a phone screen with three app rows each with a small recurring arrow", "Recurring subscriptions. Use for subscription creep, monthly drains or auto-renewals.", "subscription,recurring,auto renew,monthly,drain,apps"),
("Luxury Watch", "a wrist watch with a metal band and round face", "Luxury watch. Use for status symbols, luxury purchases or signalling wealth.", "watch,luxury,status,signal,expensive,symbol"),
("Designer Handbag", "a structured handbag with a top handle", "Designer bag. Use for luxury goods, brand status or lifestyle inflation.", "handbag,luxury,brand,status,lifestyle inflation"),
("Car Sedan", "a simple side view of a sedan car", "Car. Use for a vehicle purchase, commuting cost or a depreciating asset.", "car,vehicle,sedan,commute,purchase,depreciation"),
("Luxury Sports Car", "a low sleek sports car in side view", "Sports car. Use for a flashy purchase, status spending or a wealth fantasy.", "sports car,luxury,status,flashy,fantasy,expensive"),
("Car With Falling Value Arrow", "a car with a downward arrow beside it", "Depreciating car. Use for depreciation, a liability disguised as an asset.", "depreciation,car,liability,value drop,asset"),
("Fuel Pump", "a fuel pump with a nozzle and hose", "Fuel pump. Use for running costs, commuting expenses or fuel prices.", "fuel,petrol,gas,running cost,commute,price"),
("Airplane Ticket", "a boarding pass ticket with a small airplane icon", "Flight ticket. Use for travel spending, a holiday goal or experiences.", "ticket,travel,flight,holiday,experience,spending"),
("Gift Box", "a wrapped gift box with a ribbon bow", "Gift box. Use for gifting, generosity, festival spending or a windfall.", "gift,present,generosity,festival,spending,reward"),
("Wedding Rings Expense", "two interlocking rings with a small price tag attached", "Rings with a price tag. Use for wedding costs, big life expenses or social pressure.", "wedding,rings,expense,big purchase,social pressure"),
("Hospital Bill", "a bill document with a small medical cross at the top", "Medical bill. Use for health costs, an unexpected expense or insurance need.", "medical bill,health cost,unexpected,emergency,insurance"),
])

add("finance/institutions", [
("Government Building", "a domed government building with columns and a flag", "Government building. Use for policy, the state, regulation or public spending.", "government,state,policy,regulation,public"),
("Central Bank", "a classical bank building with a large clock on the pediment", "Central bank. Use for monetary policy, interest rate decisions or money printing.", "central bank,monetary policy,rates,money printing,rbi,fed"),
("Tax Form", "a tax form document with checkboxes and a stamp mark", "Tax form. Use for filing taxes, deductions or compliance.", "tax,form,filing,deduction,compliance,return"),
("Tax Collector", "a stern official in a coat holding out an open hand", "Official with an open hand. Use for taxes owed, fees or a mandatory payment.", "tax,collector,official,fees,mandatory,payment"),
("Courthouse", "a courthouse building with wide steps and columns", "Courthouse. Use for law, disputes, legal cost or regulation.", "court,law,legal,dispute,regulation,justice"),
("Gavel", "a judge gavel resting on a round sound block", "Gavel. Use for a ruling, a decision, law or final judgement.", "gavel,judge,ruling,decision,law,verdict"),
("Insurance Policy Document", "a document with a shield symbol at the top", "Insurance policy. Use for cover, protection, premiums or claims.", "insurance,policy,cover,protection,premium,claim"),
("Shield Protection", "a plain protective shield outline", "Shield. Use for safety, protection of capital or risk defence.", "shield,protection,safety,defence,security,risk"),
("Company Office Tower", "a tall office tower building with grid windows", "Office tower. Use for corporations, employers or big business.", "office,corporate,company,employer,business,tower"),
("Factory", "a factory building with two chimneys", "Factory. Use for production, industry, real economy or manufacturing.", "factory,industry,production,manufacturing,economy"),
("Charity Donation Box", "a box with a coin slot and a heart symbol on the front", "Donation box. Use for giving, charity, generosity or social spending.", "charity,donation,giving,generosity,box,heart"),
("Bribe Envelope Under Table", "an envelope of cash being passed beneath a table between two hands", "Cash passed under a table. Use for bribery, corruption or an unethical deal.", "bribe,corruption,under table,unethical,cash,deal"),
("Briefcase Of Cash", "an open briefcase filled with neat rows of banknotes", "Briefcase of money. Use for a large payoff, a deal, a bribe or a big sum.", "briefcase,cash,payoff,deal,bribe,large sum"),
("Corrupt Tilted Scales", "a balance scale tipped down by a bag of coins on one pan", "Scales tipped by money. Use for corruption, bought influence or unfair systems.", "corruption,scales,influence,unfair,bias,money power"),
])

# ---------------- PEOPLE ----------------
add("people/emotions", [
("Person Confused", "a standing person shrugging with a question mark above the head", "Confused person. Use for not understanding, uncertainty or too many options.", "confused,unsure,question,shrug,uncertain,lost"),
("Person Thinking", "a person with a hand on the chin looking upward thoughtfully", "Thinking person. Use for deliberating, weighing a decision or reflecting.", "thinking,ponder,decide,reflect,consider"),
("Person Aha Moment", "a person with a raised finger and a lightbulb above the head", "Aha moment. Use for insight, realisation or finally understanding.", "aha,insight,idea,realisation,eureka,understand"),
("Person Celebrating", "a person jumping with both arms raised in celebration", "Celebrating person. Use for success, a goal achieved or good news.", "celebrate,success,win,happy,achieve,joy"),
("Person Success Arms Up", "a person standing on a small podium with arms raised in a V", "Victory pose. Use for reaching a milestone, winning or confidence.", "success,victory,win,milestone,confidence,podium"),
("Person Frustrated", "a person with both hands on the head and a frowning face", "Frustrated person. Use for setbacks, mistakes or things going wrong.", "frustrated,stress,mistake,setback,upset,angry"),
("Person Stressed With Papers", "a person at a desk surrounded by flying papers looking overwhelmed", "Overwhelmed by paperwork. Use for stress, admin overload or too many bills.", "stressed,overwhelmed,papers,bills,workload,anxiety"),
("Person Juggling Tasks", "a person juggling four small labelled balls", "Juggling person. Use for balancing priorities, multitasking or competing demands.", "juggling,multitask,balance,priorities,busy,demands"),
("Person Tired At Desk", "a person slumped over a desk with a laptop and a mug", "Exhausted at a desk. Use for burnout, overwork or fatigue.", "tired,burnout,exhausted,overwork,fatigue,desk"),
("Person Sleeping", "a person sleeping in bed with small z letters above", "Sleeping person. Use for rest, passive income while you sleep, or ignoring a problem.", "sleep,rest,night,passive,ignore,recovery"),
("Person Anxious", "a person hugging their knees with a wavy scribble above the head", "Anxious person. Use for worry, money anxiety or fear about the future.", "anxious,worry,fear,anxiety,stress,scared"),
("Person Relieved", "a person exhaling with a hand on the chest and a small smile", "Relieved person. Use for relief after solving a problem or clearing a debt.", "relief,calm,exhale,solved,peace,relaxed"),
("Person Determined", "a person walking forward with clenched fists and a firm expression", "Determined person. Use for commitment, discipline or pushing through.", "determined,discipline,commit,resolve,persist"),
("Person Doubtful", "a person with one raised eyebrow and crossed arms", "Sceptical person. Use for doubt, disbelief or questioning a claim.", "doubt,skeptical,disbelief,question,unconvinced"),
("Person Greedy Eyes", "a person leaning forward with wide eyes and hands reaching for coins", "Greedy reaching person. Use for greed, FOMO or chasing returns.", "greed,fomo,chase,desire,want,grab"),
("Person Regret", "a person with a hand covering the face looking down", "Regretful person. Use for regret after a bad decision or a missed chance.", "regret,mistake,shame,missed,facepalm,sorry"),
("Person Envious Comparing", "a person looking over a fence at a neighbour with a bigger house", "Comparing over a fence. Use for envy, keeping up with others or social comparison.", "envy,compare,neighbour,jealous,keeping up,social"),
("Person Calm Meditating", "a person sitting cross legged meditating with closed eyes", "Meditating person. Use for calm, mindfulness, patience or emotional control.", "meditate,calm,mindful,patience,peace,control"),
("Person Overwhelmed By Choices", "a person standing in front of a shelf of many identical boxes looking stunned", "Too many options. Use for choice overload or decision paralysis.", "choice overload,paralysis,options,overwhelmed,decide"),
])

add("people/actions", [
("Person Presenting At Board", "a person pointing at a chart on a presentation board with a stick", "Presenting at a board. Use for explaining, teaching, a pitch or a lesson.", "present,explain,teach,pitch,board,chart"),
("Person Teaching Class", "a person in front of a blackboard facing three seated figures", "Teaching a class. Use for education, mentoring or sharing knowledge.", "teach,class,education,mentor,knowledge,students"),
("Person Speaking On Stage", "a person on a stage speaking into a microphone at a podium", "Speaking on stage. Use for public speaking, authority or an expert view.", "speaker,stage,podium,public speaking,expert,authority"),
("Two People Talking", "two people facing each other in conversation with speech bubbles", "Two people talking. Use for a conversation, advice or negotiation.", "conversation,talk,discuss,advice,negotiate,two people"),
("People Arguing", "two people facing each other with jagged speech bubbles and raised hands", "Argument. Use for conflict, disagreement or a money fight.", "argue,conflict,disagree,fight,tension,dispute"),
("Handshake Deal", "two hands clasped in a firm handshake", "Handshake. Use for a deal, agreement, partnership or trust.", "handshake,deal,agreement,partnership,trust,contract"),
("Team High Five", "two people high fiving with raised hands", "High five. Use for teamwork, a shared win or celebration.", "high five,team,win,celebrate,together,success"),
("Group Meeting Table", "four people seated around a round table with papers", "Meeting around a table. Use for teamwork, planning or a family discussion.", "meeting,table,team,planning,discussion,group"),
("Crowd Of People", "a dense group of simple head and shoulder figures", "Crowd. Use for the masses, herd behaviour, society or the market.", "crowd,masses,herd,society,market,public"),
("Queue Of People", "four people standing one behind another in a line", "Queue. Use for waiting, following the crowd, or demand.", "queue,line,waiting,follow,demand,crowd"),
("Person Climbing Ladder", "a person climbing a tall ladder", "Climbing a ladder. Use for career progress, moving up or effort over time.", "ladder,climb,career,progress,effort,up"),
("Person At Crossroads", "a person standing before a road that splits into two directions", "At a crossroads. Use for a decision point, choosing a path or a fork in life.", "crossroads,decision,fork,choice,path,direction"),
("Person Running", "a person running forward with motion lines", "Running person. Use for speed, urgency, chasing goals or being rushed.", "running,speed,rush,chase,urgent,move"),
("Person Running Late", "a person running while looking at a wristwatch", "Running late. Use for time pressure, missed deadlines or starting late.", "late,time pressure,deadline,rush,missed,hurry"),
("Person Walking With Briefcase", "a person walking with a briefcase in hand", "Commuter with a briefcase. Use for work, a job, a career or the daily grind.", "work,job,commute,briefcase,career,office"),
("Person Reading Book", "a person seated reading an open book", "Reading a book. Use for learning, book summaries or self-education.", "reading,book,learning,study,knowledge,self education"),
("Person Writing Journal", "a person writing in an open notebook with a pen", "Journalling. Use for tracking, reflection, planning or budgeting by hand.", "journal,write,track,reflect,plan,notebook"),
("Person On Phone Scrolling", "a person hunched over looking at a phone screen", "Scrolling a phone. Use for distraction, social media or online shopping.", "phone,scroll,distraction,social media,online,addiction"),
("Person Shopping", "a person pushing a shopping cart with bags", "Shopping person. Use for buying, consumer behaviour or a spending trip.", "shopping,buy,consumer,cart,spend,store"),
("Person At ATM", "a person standing at an ATM machine taking cash", "Using an ATM. Use for withdrawing money, easy access or a cash habit.", "atm,withdraw,cash,bank,access,habit"),
("Person Giving Money", "a hand extending a banknote toward another open hand", "Giving money away. Use for paying, lending, donating or gifting.", "give,pay,lend,donate,gift,transfer"),
("Person Receiving Money", "an open hand catching a falling banknote", "Receiving money. Use for income, a refund, a gift or getting paid.", "receive,income,paid,refund,gift,earn"),
("Person Saving In Piggy Bank", "a person dropping a coin into a large piggy bank", "Person saving money. Use for building a savings habit or paying yourself first.", "save,piggy bank,habit,pay yourself first,deposit"),
("Person Pushing Boulder Uphill", "a person pushing a large round boulder up a slope", "Pushing a boulder uphill. Use for hard effort, struggle or an uphill battle.", "boulder,uphill,struggle,effort,hard,burden"),
("Person Breaking Free Of Chains", "a person with arms outstretched snapping chains at the wrists", "Breaking free. Use for financial freedom, quitting a job or escaping debt.", "freedom,break free,chains,escape,liberation,quit"),
("Person On Treadmill", "a person running on a treadmill going nowhere", "Treadmill runner. Use for the rat race, hedonic treadmill or spinning wheels.", "treadmill,rat race,hedonic,no progress,grind,stuck"),
("Person Planting Seed", "a person kneeling and planting a small seed in soil", "Planting a seed. Use for starting early, small beginnings or investing for later.", "plant,seed,start,early,invest,beginning"),
("Person Watering Plant", "a person watering a small potted plant with a can", "Watering a plant. Use for consistent effort, nurturing a habit or steady contributions.", "water,nurture,consistent,habit,grow,effort"),
("Person Climbing Mountain", "a person climbing a steep mountain slope with a flag at the summit", "Climbing to a summit. Use for a big goal, a long journey or ambition.", "mountain,climb,goal,journey,ambition,summit"),
("Person Standing On Summit", "a person standing on a mountain peak with arms raised beside a flag", "Standing at the summit. Use for achievement, arriving at a goal or perspective.", "summit,achieve,goal reached,perspective,success,peak"),
("Person Falling", "a person tumbling downward with arms flailing", "Falling person. Use for failure, a setback or losing control.", "fall,fail,setback,lose control,drop,crash"),
("Person Getting Up After Fall", "a person on one knee rising from the ground with a determined face", "Getting back up. Use for resilience, recovery after a loss or trying again.", "resilience,recover,get up,try again,comeback,grit"),
("Person Being Pulled By Strings", "a person with strings attached to the limbs held from above", "Puppet on strings. Use for manipulation, marketing control or hidden influence.", "puppet,strings,manipulation,control,influence,marketing"),
("Person Wearing Mask", "a person holding a smiling mask in front of a neutral face", "Person with a mask. Use for pretence, projecting success or hiding true finances.", "mask,pretend,facade,hide,image,appearance"),
])

add("people/roles", [
("Boss Figure", "a person in a suit standing with arms crossed", "Person in a suit with crossed arms. Use for a boss, manager or authority figure.", "boss,manager,authority,suit,leader,employer"),
("Employee At Desk", "a person seated at a desk with a computer and a small plant", "Office worker at a desk. Use for a job, salaried work or the nine to five.", "employee,office,desk,job,salary,work"),
("Entrepreneur With Idea", "a person holding a lightbulb standing next to a small shop sign", "Entrepreneur with an idea. Use for starting a business or taking a risk.", "entrepreneur,business,idea,risk,founder,startup"),
("Freelancer At Home", "a person working on a laptop on a couch with a mug", "Working from home. Use for freelancing, remote work or a home side hustle.", "freelancer,remote,home,laptop,side hustle,couch"),
("Financial Advisor", "a person in a suit pointing at a chart while seated across a desk from a client", "Advisor with a client. Use for financial advice, planning or a consultation.", "advisor,planner,consultation,advice,client,meeting"),
("Salesperson Pitching", "a person with an open hand gesture presenting a product box", "Salesperson pitching. Use for selling, persuasion or marketing pressure.", "salesperson,pitch,sell,persuade,marketing,offer"),
("Scammer With Hidden Hand", "a smiling person in a suit with one hand behind the back holding a card", "Person hiding something behind their back. Use for scams, hidden agendas or fraud.", "scam,fraud,hidden,deceive,trick,dishonest"),
("Beggar With Bowl", "a seated person holding an empty bowl", "Person with an empty bowl. Use for poverty, hardship or having nothing left.", "poverty,broke,hardship,beg,nothing,poor"),
("Wealthy Person", "a person in a top hat and coat holding a cane beside a coin stack", "Well-dressed wealthy figure. Use for the rich, old money or wealth stereotypes.", "wealthy,rich,tycoon,money,elite,stereotype"),
("Retired Person", "an older person with a walking stick sitting on a bench", "Older person on a bench. Use for retirement, later life or long-term planning.", "retired,old age,senior,bench,later life,pension"),
("Family Of Four", "two adults and two children standing together", "Family group. Use for household finances, dependents or family goals.", "family,household,children,dependents,together,goals"),
("Couple Together", "two people standing side by side holding hands", "Couple. Use for shared finances, partnership or joint decisions.", "couple,partner,shared,joint,relationship,together"),
("Parent And Child", "an adult holding the hand of a small child", "Parent with a child. Use for teaching kids about money, legacy or responsibility.", "parent,child,teach,legacy,responsibility,family"),
("Doctor With Stethoscope", "a person in a coat wearing a stethoscope", "Doctor. Use for health costs, expert diagnosis or a check-up metaphor.", "doctor,health,stethoscope,diagnosis,checkup,expert"),
("Therapist Session", "two people seated facing each other one holding a notepad", "Therapy session. Use for counselling, emotional support or money therapy.", "therapy,counselling,session,support,psychology,talk"),
("Coach With Whistle", "a person in sportswear holding a clipboard and wearing a whistle", "Coach. Use for coaching, accountability or guided practice.", "coach,accountability,guide,practice,training,mentor"),
("Mentor And Student", "an older person pointing at a book while a younger person watches", "Mentor guiding a student. Use for mentorship, advice or learning from experience.", "mentor,student,guide,advice,learn,experience"),
("Student With Books", "a young person carrying a stack of books and a backpack", "Student with books. Use for education, student loans or early adulthood.", "student,books,education,college,loan,young"),
("Crowd Follower Sheep", "a small flock of sheep walking in the same direction", "Flock of sheep. Use for herd mentality, following the crowd or conformity.", "sheep,herd,follow,conformity,crowd,mentality"),
])

# ---------------- PSYCHOLOGY ----------------
add("psychology/mind", [
("Brain", "a simple brain outline with curved folds", "Brain. Use for thinking, psychology, the mind or cognition.", "brain,mind,psychology,cognition,think,mental"),
("Brain With Gears", "a brain outline with gear wheels inside it", "Brain with gears. Use for mental effort, processing or working through a problem.", "brain,gears,effort,processing,thinking,problem solving"),
("Brain Split Two Halves", "a brain divided down the middle into two contrasting halves", "Split brain. Use for two systems of thinking, logic vs emotion or inner conflict.", "brain,split,two systems,logic,emotion,conflict"),
("Heart Versus Head", "a heart and a brain side by side with a small lightning bolt between them", "Heart and brain opposed. Use for emotion vs reason in money decisions.", "heart,head,emotion,reason,conflict,decision"),
("Lizard Brain", "a small lizard sitting inside a brain outline", "Lizard in a brain. Use for instinct, primal fear or the reptilian brain.", "lizard brain,instinct,primal,fear,reptilian,survival"),
("Elephant And Rider", "a small rider seated on a large elephant holding thin reins", "Rider on an elephant. Use for willpower vs emotion, or controlling impulses.", "elephant,rider,willpower,emotion,control,impulse"),
("Monkey Mind", "a small monkey swinging between two branches with scribbles around it", "Restless monkey. Use for a distracted mind, mental chatter or restlessness.", "monkey mind,distraction,chatter,restless,focus,noise"),
("Mind Full Of Clutter", "a head outline filled with tangled scribble lines", "Cluttered head. Use for mental overload, confusion or noisy thinking.", "clutter,overload,confusion,noise,mental,tangled"),
("Clear Mind", "a head outline with a single clean straight line inside", "Clear head. Use for clarity, focus or a simplified mental model.", "clarity,clear,focus,simple,calm,mental model"),
("Memory Box", "a small box with a head silhouette on the lid and photos inside", "Memory box. Use for memories, past experiences shaping decisions or nostalgia.", "memory,past,experience,nostalgia,recall,box"),
("Lightbulb Idea", "a lightbulb with radiating lines around it", "Lightbulb. Use for an idea, insight or a bright solution.", "lightbulb,idea,insight,solution,inspiration,bright"),
("Lightbulb Broken", "a lightbulb with a cracked glass and no rays", "Broken lightbulb. Use for a failed idea, a dead end or lost motivation.", "broken,idea,failed,dead end,lost,dark"),
("Tug Of War", "two figures pulling opposite ends of a rope", "Tug of war. Use for inner conflict, competing priorities or trade-offs.", "tug of war,conflict,competing,priorities,tension,tradeoff"),
])

add("psychology/behavior", [
("Habit Loop", "three circular arrows connecting a bell a hand and a star in a loop", "Cue action reward loop. Use for habit loops, conditioning or behaviour change.", "habit,loop,cue,reward,behaviour,conditioning"),
("Willpower Battery", "a battery icon showing a low charge level", "Draining battery. Use for willpower depletion, decision fatigue or low energy.", "willpower,battery,depletion,fatigue,energy,drain"),
("Temptation Cookie", "a single cookie on a plate with a small radiating shine", "Tempting treat. Use for temptation, instant gratification or the marshmallow test.", "temptation,treat,instant gratification,marshmallow,self control"),
("Marshmallow Test", "one marshmallow on a plate beside a plate with two marshmallows and a clock", "One now or two later. Use for delayed gratification and patience.", "delayed gratification,patience,marshmallow,now vs later,self control"),
("Comfort Zone Circle", "a small circle labelled inside a larger dashed circle with an arrow crossing out", "Stepping outside a circle. Use for the comfort zone and growth beyond it.", "comfort zone,growth,risk,stretch,change,boundary"),
("Procrastination Clock", "a person lounging beside a large clock with a pile of untouched tasks", "Putting things off. Use for procrastination, delay or avoidance.", "procrastination,delay,avoid,putting off,later,tasks"),
("Distraction Notifications", "a phone with several notification bubbles popping out of the screen", "Notification overload. Use for distraction, attention hijacking or digital noise.", "distraction,notifications,attention,phone,noise,interrupt"),
("Focus Tunnel", "a person looking through a narrow tunnel at a bright target at the end", "Looking through a tunnel. Use for focus, tunnel vision or single-minded pursuit.", "focus,tunnel vision,narrow,target,attention,pursuit"),
("Anchor Bias", "a price tag with a large crossed out number and a smaller number below", "Crossed-out price with a lower one. Use for anchoring bias and fake discounts.", "anchoring,bias,price,discount,reference,persuasion"),
("Loss Aversion Scale", "a balance scale where a small loss weight outweighs a larger gain weight", "Loss outweighing gain. Use for loss aversion and fear of losing money.", "loss aversion,bias,fear,gain,scale,behavioural"),
("Sunk Cost Bucket", "a person continuing to pour coins into a bucket that is already cracked", "Pouring more into a broken bucket. Use for sunk cost fallacy or throwing good money after bad.", "sunk cost,fallacy,bias,persist,waste,bad money"),
("Confirmation Bias Filter", "a funnel filtering shapes so only one shape type passes through", "Filtering only what fits. Use for confirmation bias or selective evidence.", "confirmation bias,filter,selective,evidence,belief"),
("Echo Chamber", "a person inside a circle of speech bubbles all pointing back at them", "Surrounded by the same voices. Use for echo chambers, group think or bias reinforcement.", "echo chamber,groupthink,bias,reinforce,bubble,opinions"),
("FOMO Magnet", "a horseshoe magnet pulling a small crowd of figures toward it", "Magnet pulling people. Use for FOMO, hype cycles or crowd attraction.", "fomo,magnet,hype,crowd,attraction,pull"),
("Herd Stampede", "several figures running together in the same direction with dust lines", "Stampede. Use for panic selling, buying manias or herd behaviour.", "herd,stampede,panic,mania,crowd,follow"),
("Blindfolded Person", "a person walking forward wearing a blindfold with arms outstretched", "Blindfolded walker. Use for investing without information or wilful ignorance.", "blindfold,ignorance,blind,unaware,risk,uninformed"),
("Rose Tinted Glasses", "a pair of glasses with small hearts drawn on the lenses", "Rose-tinted glasses. Use for optimism bias or seeing what you want to see.", "optimism bias,glasses,rose tinted,illusion,bias"),
("Mirror Reflection", "a person standing in front of a mirror seeing a different sized reflection", "Distorted mirror reflection. Use for self-image, self-worth or honest self-assessment.", "mirror,self image,reflection,self worth,honest,identity"),
("Iceberg Conscious Unconscious", "an iceberg with a small head icon above water and a large one below", "Iceberg of the mind. Use for unconscious drivers of behaviour or hidden beliefs.", "unconscious,hidden,beliefs,iceberg,depth,drivers"),
("Money Script Note", "a small handwritten note pinned to a head outline", "A belief note pinned to the mind. Use for money scripts, childhood beliefs or inherited attitudes.", "money script,belief,childhood,attitude,inherited,mindset"),
("Fixed Versus Growth Mindset", "a stone block beside a small sprouting plant", "Stone versus sprout. Use for fixed versus growth mindset.", "mindset,fixed,growth,change,learning,belief"),
("Gratitude Journal", "an open notebook with three short lines and a small heart", "Gratitude list. Use for contentment, gratitude practice or enough-ness.", "gratitude,journal,contentment,enough,practice,appreciate"),
("Dopamine Hit", "a small burst of radiating lines coming from a phone screen with a heart icon", "Dopamine burst from a screen. Use for reward loops, likes or instant pleasure.", "dopamine,reward,likes,pleasure,hit,screen"),
("Stress Cloud Over Head", "a small dark rain cloud hovering above a person head", "Cloud over a person. Use for worry, a bad mood or looming problems.", "stress,cloud,worry,mood,problem,gloom"),
("Anxiety Spiral", "a person inside a tightening spiral line", "Person caught in a spiral. Use for anxiety, rumination or an escalating worry loop.", "anxiety,spiral,rumination,worry,loop,escalating"),
("Calm Sun Breaking Through", "a sun with rays emerging from behind a cloud", "Sun through clouds. Use for relief, optimism or recovery after a hard period.", "sun,clouds,relief,optimism,recovery,hope"),
("Identity Circle", "three concentric circles with a small figure at the center", "Concentric circles with a person at the core. Use for identity, values and behaviour layers.", "identity,values,layers,core,self,behaviour"),
("Delayed Reward Timeline", "a small coin on the left and a large coin on the right joined by a long arrow", "Small now, large later. Use for patience, compounding or long-term thinking.", "delayed reward,patience,long term,compounding,later,time"),
])

# ---------------- CROSS INDUSTRY ----------------
add("other/health", [
("Heart", "a simple heart outline", "Heart. Use for health, love, care or what you value.", "heart,love,health,care,value,emotion"),
("Heartbeat Line", "a horizontal line with a heartbeat spike in the middle", "Heartbeat line. Use for vitality, health metrics or a pulse of activity.", "heartbeat,pulse,health,vitality,ecg,monitor"),
("Dumbbell", "a single dumbbell weight", "Dumbbell. Use for exercise, effort, strength or building capacity.", "dumbbell,exercise,gym,strength,effort,fitness"),
("Running Shoes", "a pair of sport running shoes", "Running shoes. Use for starting a habit, fitness or getting moving.", "shoes,running,fitness,habit,start,movement"),
("Water Bottle", "a sports water bottle with a cap", "Water bottle. Use for basic habits, health basics or daily discipline.", "water,bottle,habit,health,daily,basics"),
("Apple Fruit", "a whole apple with a leaf on the stem", "Apple. Use for healthy choices, good habits or a simple wholesome option.", "apple,healthy,fruit,good choice,habit,simple"),
("Burger Fast Food", "a stacked burger with a bun and fillings", "Burger. Use for indulgence, instant gratification or unhealthy convenience.", "burger,junk food,indulgence,instant,convenience,unhealthy"),
("Weighing Scale", "a flat bathroom weighing scale with a dial", "Bathroom scale. Use for measurement, tracking progress or being judged by numbers.", "scale,weight,measure,track,progress,numbers"),
("Pills Bottle", "a medicine bottle with a few pills beside it", "Pill bottle. Use for medical costs, a quick fix or treating symptoms.", "pills,medicine,cost,quick fix,symptom,health"),
("Hospital Building", "a hospital building with a cross sign on the front", "Hospital. Use for medical emergencies, health expenses or insurance need.", "hospital,medical,emergency,health cost,insurance"),
("Gym Building", "a building with a dumbbell sign above the door", "Gym. Use for memberships, unused subscriptions or fitness commitment.", "gym,membership,subscription,fitness,commitment,unused"),
("Meditation Cushion", "a round floor cushion with a small candle beside it", "Meditation cushion. Use for stillness, routine or mental practice.", "meditation,cushion,stillness,routine,practice,calm"),
("Bed Sleep", "a simple bed with a pillow and a blanket", "Bed. Use for rest, recovery, sleep habits or downtime.", "bed,sleep,rest,recovery,habit,downtime"),
("Cigarette Crossed Out", "a cigarette with a diagonal line crossing through it", "No smoking. Use for quitting a bad habit or cutting a costly vice.", "cigarette,quit,bad habit,vice,stop,cost"),
])

add("other/relationships", [
("Two Hearts", "two overlapping hearts", "Two hearts. Use for a relationship, a partnership or shared values.", "hearts,relationship,partnership,love,shared,couple"),
("Broken Heart", "a heart split down the middle with a crack line", "Broken heart. Use for a breakup, betrayal or a costly split.", "broken heart,breakup,betrayal,split,loss,divorce"),
("Wedding Rings", "two interlocking wedding rings", "Wedding rings. Use for marriage, commitment or joint finances.", "wedding,rings,marriage,commitment,joint,union"),
("Family Home", "a house with a heart shape in the window", "Home with a heart. Use for family life, a home goal or belonging.", "family,home,belonging,house,heart,goal"),
("Hug Between Two People", "two people embracing in a hug", "Hug. Use for support, comfort or emotional safety.", "hug,support,comfort,safety,care,empathy"),
("Friendship Group", "three people standing with arms over each other shoulders", "Group of friends. Use for social circle, peer influence or support network.", "friends,social,peer,influence,support,circle"),
("Peer Pressure Circle", "one person in the middle of a ring of figures leaning inward", "Surrounded by peers. Use for peer pressure, social spending or conformity.", "peer pressure,social,conformity,influence,spending,group"),
("Trust Bridge", "two cliff edges joined by a simple wooden bridge with a figure crossing", "Bridge between two cliffs. Use for trust, connection or bridging a gap.", "trust,bridge,connection,gap,cross,relationship"),
("Boundary Fence", "a low picket fence with a small gate", "Fence with a gate. Use for boundaries, saying no or protecting your limits.", "boundary,fence,gate,limits,say no,protect"),
])

add("other/learning", [
("Open Book", "an open book with visible page lines", "Open book. Use for reading, a book summary or an idea from a book.", "book,open,read,summary,knowledge,study"),
("Stack Of Books", "three books stacked on top of each other", "Book stack. Use for a reading list, accumulated knowledge or study.", "books,stack,reading list,knowledge,study,library"),
("Graduation Cap", "a graduation mortarboard cap with a tassel", "Graduation cap. Use for education, degrees or the cost of learning.", "graduation,degree,education,cap,college,learning"),
("Diploma Certificate", "a rolled diploma tied with a ribbon", "Diploma. Use for credentials, achievement or return on education.", "diploma,certificate,credential,achievement,education"),
("Notebook And Pen", "a spiral notebook with a pen resting on it", "Notebook and pen. Use for planning, note taking or writing things down.", "notebook,pen,plan,notes,write,record"),
("School Building", "a school building with a bell tower and a flag", "School. Use for education systems, childhood or early learning.", "school,education,childhood,learning,building,system"),
("Student Loan Chain Book", "a book with a small chain and padlock wrapped around it", "Chained book. Use for student debt, the cost of education or being tied to a loan.", "student loan,debt,education cost,chain,tied,burden"),
("Trophy", "a two handled trophy cup on a base", "Trophy. Use for achievement, a reward or winning.", "trophy,award,achievement,win,reward,prize"),
("Medal", "a circular medal hanging from a ribbon", "Medal. Use for recognition, a milestone or an earned reward.", "medal,recognition,milestone,award,earned,honour"),
])

add("other/tech", [
("Laptop", "an open laptop computer", "Laptop. Use for work, online income, research or digital life.", "laptop,computer,work,online,digital,research"),
("Smartphone", "a smartphone with a blank screen", "Smartphone. Use for apps, digital habits or mobile spending.", "phone,smartphone,mobile,apps,digital,habit"),
("Robot Assistant", "a friendly boxy robot with antenna and simple arms", "Robot. Use for AI, automation, or a tool doing work for you.", "robot,ai,automation,tool,tech,assistant"),
("Cloud Storage", "a cloud outline with an upload arrow beneath it", "Cloud with an arrow. Use for online services, storage or subscriptions.", "cloud,storage,online,service,subscription,upload"),
("Email Envelope", "a sealed envelope with a fold line forming an M shape", "Email envelope. Use for messages, newsletters or an offer landing in your inbox.", "email,envelope,message,inbox,newsletter,offer"),
("Notification Bell", "a bell with a small badge circle at the corner", "Notification bell. Use for alerts, reminders or attention grabbing apps.", "bell,notification,alert,reminder,attention,app"),
("Social Media Likes", "a phone screen with three thumbs up icons floating above it", "Likes floating from a phone. Use for social validation, comparison or vanity metrics.", "likes,social media,validation,comparison,vanity,metrics"),
("Algorithm Feed", "a vertical stack of three cards flowing into a phone screen", "Feed of content. Use for algorithms, endless scroll or content shaping behaviour.", "algorithm,feed,scroll,content,recommendation,behaviour"),
("Wifi Signal", "a wifi signal symbol with three arcs", "Wifi symbol. Use for connectivity, remote work or being always online.", "wifi,signal,connectivity,online,remote,internet"),
("Padlock Security", "a closed padlock", "Padlock. Use for security, privacy, locked funds or protection.", "padlock,lock,security,privacy,protect,locked"),
("Open Padlock", "an open padlock with the shackle raised", "Open padlock. Use for access unlocked, freedom or a released restriction.", "unlock,open,access,freedom,released,padlock"),
("Key", "a single old fashioned key", "Key. Use for a solution, unlocking a result or the key idea.", "key,solution,unlock,access,answer,secret"),
])

add("other/metaphor", [
("Ladder", "a simple leaning ladder with several rungs", "Ladder. Use for step-by-step progress, climbing or levels.", "ladder,steps,progress,climb,levels,career"),
("Staircase Up", "a side view of a staircase with five steps rising", "Rising staircase. Use for gradual progress, a plan in stages or levelling up.", "staircase,steps,progress,stages,levels,gradual"),
("Bridge Over Gap", "a bridge spanning a gap between two ledges", "Bridge over a gap. Use for a solution connecting where you are to where you want to be.", "bridge,gap,solution,connect,transition,path"),
("Door Opening", "a slightly open door with light coming through the gap", "Opening door. Use for an opportunity, a new chapter or a choice.", "door,opportunity,open,new chapter,choice,chance"),
("Two Doors Choice", "two closed doors side by side each with a different handle", "Two doors. Use for a binary choice, two paths or a decision.", "two doors,choice,decision,paths,options,binary"),
("Maze", "a square maze puzzle with a single winding path", "Maze. Use for complexity, confusion or finding a way through a system.", "maze,complex,confusion,puzzle,path,system"),
("Compass", "a round compass with a needle pointing north", "Compass. Use for direction, values, principles or finding your way.", "compass,direction,values,principles,guide,north"),
("Map With Pin", "a folded map with a location pin standing on it", "Map with a pin. Use for a destination, a plan or knowing where you are.", "map,pin,destination,plan,location,journey"),
("Lighthouse", "a lighthouse with a beam of light shining out", "Lighthouse. Use for guidance, a clear principle or a fixed reference point.", "lighthouse,guidance,principle,beacon,reference,direction"),
("Anchor", "a ship anchor with a rope loop", "Anchor. Use for stability, being held back or a fixed reference number.", "anchor,stability,held back,fixed,reference,weight"),
("Sailing Boat", "a small sailing boat with a triangular sail on gentle waves", "Sailboat. Use for a journey, using favourable conditions or steady progress.", "boat,sail,journey,progress,voyage,tailwind"),
("Storm Cloud With Lightning", "a dark cloud with a lightning bolt and rain lines", "Storm cloud. Use for a crisis, a downturn or turbulent times.", "storm,crisis,downturn,turbulence,lightning,bad times"),
("Umbrella Open", "an open umbrella with a curved handle", "Open umbrella. Use for protection, insurance or being prepared.", "umbrella,protection,insurance,prepared,shelter,rain"),
("Life Buoy Ring", "a ring shaped life buoy with straps", "Life buoy. Use for rescue, a safety net or emergency help.", "life buoy,rescue,safety net,emergency,help,support"),
("Hourglass", "an hourglass with sand falling through the middle", "Hourglass. Use for time passing, limited time or the value of starting early.", "hourglass,time,deadline,passing,early,limited"),
("Wall Clock", "a round wall clock with hands and hour marks", "Clock. Use for time, schedules, deadlines or time as a resource.", "clock,time,schedule,deadline,resource,hours"),
("Calendar Page", "a calendar page grid with one date circled", "Calendar. Use for dates, monthly cycles, planning or a deadline.", "calendar,date,monthly,plan,deadline,schedule"),
("Domino Chain", "five dominoes in a row with the first one tipping over", "Falling dominoes. Use for chain reactions, small actions with big effects or contagion.", "dominoes,chain reaction,cascade,small action,effect,contagion"),
("Puzzle Pieces", "two jigsaw puzzle pieces fitting together", "Puzzle pieces. Use for fit, a missing piece or how parts connect.", "puzzle,fit,missing piece,connect,parts,solution"),
("Missing Puzzle Piece", "a jigsaw puzzle with one empty gap shaped slot", "Puzzle with a gap. Use for something missing, an incomplete plan or a knowledge gap.", "missing,gap,incomplete,puzzle,knowledge gap,unknown"),
("Seed Sprout", "a small seedling sprouting from soil with two leaves", "Seedling. Use for beginnings, small starts or early-stage growth.", "seed,sprout,beginning,small start,growth,early"),
("Full Grown Tree", "a broad leafy tree with a thick trunk and visible roots", "Mature tree with roots. Use for long-term results, stability or deep foundations.", "tree,mature,long term,roots,stability,foundation"),
("Fire Flame", "a single flame shape", "Flame. Use for urgency, motivation, burning cash or a hot trend.", "fire,flame,urgency,motivation,hot,burn"),
("Ice Cube", "a cube shaped ice block with a small shine mark", "Ice cube. Use for frozen funds, cooling off or a locked position.", "ice,frozen,cool off,locked,pause,cold"),
("Magnifying Glass", "a magnifying glass with a handle", "Magnifying glass. Use for research, scrutiny, analysis or finding details.", "magnifier,research,analyse,scrutiny,detail,search"),
("Telescope", "a telescope on a tripod pointing upward", "Telescope. Use for long-range vision, forecasting or looking ahead.", "telescope,vision,forecast,long range,future,ahead"),
("Gears Interlocking", "two interlocking gear wheels", "Interlocking gears. Use for systems, mechanisms or how parts work together.", "gears,system,mechanism,process,work together,machine"),
("Snowball Rolling", "a snowball rolling down a slope leaving a trail and growing", "Growing snowball. Use for momentum, compounding effects or habits building.", "snowball,momentum,compounding,growth,build,effect"),
("Bucket With Water", "a bucket filled with water with a small wave at the top", "Full bucket. Use for capacity, a reserve or something filling up.", "bucket,capacity,reserve,fill,container,water"),
("Pipeline With Valve", "a horizontal pipe with a round valve wheel in the middle", "Pipe with a valve. Use for controlling flow, throttling spending or managing cash flow.", "pipe,valve,flow,control,throttle,cash flow"),
("Traffic Light", "a traffic signal with three round lights", "Traffic light. Use for go, caution and stop rules or decision signals.", "traffic light,go,stop,caution,signal,rule"),
("Speed Limit Sign", "a round road sign with a bold number circle", "Speed limit sign. Use for limits, rules, caps or slowing down.", "limit,sign,rule,cap,slow down,road"),
("Road With Milestones", "a winding road going toward the horizon with small marker posts", "Winding road with markers. Use for a long journey, a roadmap or stages ahead.", "road,journey,roadmap,milestones,stages,path"),
("Fork In The Road", "a road splitting into two paths with a signpost in the middle", "Fork in the road. Use for a decision point or two possible futures.", "fork,road,decision,two paths,choice,future"),
("Mountain With Flag", "a mountain peak with a small flag planted at the top", "Mountain with a flag. Use for a big goal, a target or an ambition.", "mountain,flag,goal,target,ambition,summit"),
("Finish Line Ribbon", "a finish line ribbon stretched between two posts", "Finish line. Use for reaching a target, completion or the end of a plan.", "finish line,complete,target,end,goal,race"),
("Starting Line Blocks", "a pair of athletics starting blocks on a track line", "Starting blocks. Use for beginning, day one or getting started.", "start,begin,day one,blocks,launch,first step"),
("Tortoise And Hare", "a tortoise and a hare side by side on a track line", "Tortoise and hare. Use for slow steady progress beating fast bursts.", "tortoise,hare,slow,steady,patience,race"),
("Chess Piece King", "a chess king piece", "Chess king. Use for strategy, long-term thinking or protecting what matters.", "chess,king,strategy,long term,protect,game"),
("Chess Board Moves", "a small chess board with two pieces and a dotted move line", "Chess move. Use for strategic thinking, planning moves ahead or trade-offs.", "chess,strategy,planning,moves,tactics,think ahead"),
("Dice Pair", "two dice showing dots on their faces", "Dice. Use for chance, gambling, luck or randomness in outcomes.", "dice,chance,gamble,luck,random,odds"),
("Slot Machine", "a slot machine with a lever and three reel windows", "Slot machine. Use for gambling, speculation or chasing a jackpot.", "slot machine,gamble,speculation,jackpot,casino,chase"),
("Lottery Ticket", "a lottery ticket with a row of numbered circles", "Lottery ticket. Use for get-rich-quick hopes, low odds or false shortcuts.", "lottery,ticket,odds,get rich quick,shortcut,hope"),
("Magnet Horseshoe", "a horseshoe magnet with lines showing pull", "Magnet. Use for attraction, pulling in customers or being drawn to something.", "magnet,attract,pull,draw,influence,force"),
("Filter Sieve", "a round sieve with small holes and grains passing through", "Sieve. Use for filtering options, screening choices or separating signal from noise.", "sieve,filter,screen,separate,signal,noise"),
("Hammer And Nail", "a hammer striking a nail into a board", "Hammer and nail. Use for tools, doing the work or a simple direct fix.", "hammer,nail,tool,work,fix,build"),
("Toolbox", "an open toolbox with a few tools sticking out", "Toolbox. Use for a set of methods, resources or a framework kit.", "toolbox,tools,methods,resources,framework,kit"),
("Blueprint Plan", "a rolled out blueprint sheet with a simple house outline drawn on it", "Blueprint. Use for a plan, design or a structured approach.", "blueprint,plan,design,structure,approach,drawing"),
("Foundation Bricks", "three rows of bricks forming a solid base wall", "Brick foundation. Use for fundamentals, building blocks or a strong base.", "bricks,foundation,fundamentals,base,building blocks,solid"),
("House Of Cards", "a fragile pyramid of playing cards", "House of cards. Use for a fragile system, unsustainable debt or a scheme about to collapse.", "house of cards,fragile,collapse,unsustainable,scheme,risk"),
("Safety Net", "a stretched net held between two posts with a small figure above it", "Safety net. Use for a financial cushion, backup plan or insurance.", "safety net,cushion,backup,insurance,fallback,protection"),
("Tightrope Walker", "a figure balancing on a tightrope with a long pole", "Tightrope walk. Use for risky balance, living paycheck to paycheck or fine margins.", "tightrope,balance,risk,margin,paycheck to paycheck,precarious"),
("Weight On Shoulders", "a person carrying a large heavy block on their shoulders", "Carrying a heavy weight. Use for financial burden, responsibility or pressure.", "weight,burden,responsibility,pressure,heavy,carry"),
("Wings Freedom", "a pair of open feathered wings", "Open wings. Use for freedom, escape or independence.", "wings,freedom,independence,escape,fly,liberation"),
("Open Cage Door", "a bird cage with the small door standing open", "Open cage. Use for freedom regained, quitting or breaking out of a trap.", "cage,open,freedom,escape,quit,trap"),
("Hand Holding Plant", "an open palm holding a small growing plant", "Hand holding a sprout. Use for nurturing growth, care or stewardship of money.", "hand,plant,nurture,growth,care,stewardship"),
("Two Hands Exchanging", "two hands exchanging a small box and a coin", "Exchange of goods for money. Use for trade, value exchange or a transaction.", "exchange,trade,transaction,value,buy,sell"),
("Thumbs Up", "a hand giving a thumbs up", "Thumbs up. Use for approval, a good option or agreement.", "thumbs up,approve,good,agree,like,yes"),
("Thumbs Down", "a hand giving a thumbs down", "Thumbs down. Use for disapproval, a bad option or rejection.", "thumbs down,disapprove,bad,reject,dislike,no"),
("Open Palm Stop", "an open palm facing forward in a stop gesture", "Stop hand. Use for stopping a habit, saying no or a hard limit.", "stop,palm,no,limit,halt,refuse"),
("Fist Bump", "two fists touching in a fist bump", "Fist bump. Use for agreement, motivation or a small shared win.", "fist bump,agreement,motivation,team,win,encourage"),
])

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

assets, seen = [], set()
for cat, name, subject, desc, tags in DATA:
    top, sub = cat.split("/")
    sid = slug(name)
    if sid in seen:
        raise SystemExit("duplicate id: " + sid)
    seen.add(sid)
    assets.append({
        "id": sid,
        "name": name,
        "category": top,
        "subcategory": sub,
        "description": desc,
        "tags": [t.strip() for t in tags.split(",")],
        "search_text": f"{name}. {desc} Keywords: {tags}",
        "prompt": STYLE.format(subject=subject),
    })

out = {
    "library": "whiteboard-doodle-assets",
    "version": "1.0",
    "style_note": ("All prompts share one house style so generated assets stay visually consistent: "
                   "black-on-white hand-drawn doodle, thick uniform strokes, flat, no shading, no text. "
                   "Generate as raster then vectorise, or feed straight to an SVG-capable model."),
    "style_template": STYLE,
    "usage": {
        "search": "Embed or index the 'search_text' field; 'tags' works for keyword/BM25 filtering; 'category'+'subcategory' for faceting.",
        "generation": "Use 'prompt' as-is in an image model. Keep seed/style fixed per batch for consistency.",
        "naming": "'id' is a stable slug safe for filenames (e.g. piggy-bank.svg)."
    },
    "total_assets": len(assets),
    "categories": sorted({a["category"] + "/" + a["subcategory"] for a in assets}),
    "assets": assets,
}

with open("whiteboard_assets.json", "w") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)

from collections import Counter
c = Counter(a["category"] for a in assets)
print(len(assets), dict(c))